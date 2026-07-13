//! DOM Standard §2.8 "Events" + §4 "Interface EventTarget"
//! (https://dom.spec.whatwg.org/). Implements `Event`, `CustomEvent`,
//! `EventTarget`, `AbortController`, and `AbortSignal` as real
//! constructible classes installed non-enumerable on `globalThis`
//! (interface objects per Web IDL §3.7.5 — same bucket as `URL`/
//! `Headers`).
//!
//! Scope cuts vs. spec (documented simplifications — no DOM tree here,
//! so anything propagation-related is structurally a no-op):
//!   - `Event.bubbles`/`cancelable` are stored (read from `EventInit`)
//!     but never *observed*: there's no parent/child dispatch path, so
//!     `bubbles` can't propagate, and we run no default actions, so
//!     `cancelable`/`preventDefault` have no behavioral effect — only
//!     the `defaultPrevented` flag flips, matching what a synthetic
//!     `Event` in a browser observes.
//!   - `Event.composed` is stored; never read (no shadow DOM).
//!   - `Event.stopPropagation()` is a no-op (single target, no tree).
//!   - `Event.isTrusted` is always `false` — only synthetic
//!     (script-constructed) events exist here.
//!   - `Event.timeStamp` is `performance.now()` at construction time,
//!     computed from the same monotonic origin `web::performance` uses
//!     (re-calling `ensure_origin` keeps the two clocks identical).
//!   - `EventListener` is a callback interface with a single
//!     `handleEvent` operation — per Web IDL §3.11 a plain `Function`
//!     IS a valid `EventListener`, so listeners are invoked directly
//!     (`callback.call(target, event)`), not via a `.handleEvent`
//!     property lookup. (If a listener is `null`/missing, the spec says
//!     `addEventListener` is a no-op — handled.)
//!   - `AbortSignal.timeout`/`AbortSignal.any` are implemented. The
//!     `AbortError`/`TimeoutError` reasons are real `DOMException`s (via
//!     `web::dom_exception`), matching the spec.
//!   - `performance` is wired as `Performance : EventTarget` — its
//!     instance is constructed via the `EventTarget` machinery plus
//!     the three spec members (`now`/`timeOrigin`/`toJSON`) as own
//!     properties. `performance instanceof EventTarget` is `true`.
//!
//! Inheritance uses `FunctionTemplate::inherit` (rusty_v8 wires
//! `subclass.prototype.__proto__ = superclass.prototype` natively):
//!   - `CustomEvent`  extends `Event`
//!   - `AbortSignal`  extends `EventTarget`
//!
//! Per-instance state lives in internal fields via `web::native::store`
//! (same pattern as `URL`/`Headers`). Field layout:
//!   - `Event`/`CustomEvent`: field 0 = `EventInternal` (CustomEvent
//!     stores `detail` inside the same struct as `Option<Global<Value>>`).
//!   - `EventTarget`/`AbortSignal`: field 0 = `EventTargetInternal`
//!     (listener map); `AbortSignal` adds field 1 = `SignalInternal`
//!     (aborted/reason).

use crate::web::native;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

// =========================================================================
// State
// =========================================================================

/// Per-`Event`/`CustomEvent` state. Fields mutated by
/// `initCustomEvent` are wrapped in `Cell`/`RefCell` so a `&EventInternal`
/// (what `event_state` returns) can still mutate them without UB.
struct EventInternal {
    type_: RefCell<String>,
    bubbles: Cell<bool>,
    cancelable: Cell<bool>,
    composed: Cell<bool>,
    default_prevented: Cell<bool>,
    /// Set by `stopImmediatePropagation`; the dispatch loop polls this
    /// between listeners on the same target.
    stop_immediate: Cell<bool>,
    /// Whether the event was dispatched by the user agent (true) or by
    /// script (false). Abort events from `abort_signal()` set this to
    /// `true`; script-constructed events default to `false`.
    is_trusted: Cell<bool>,
    /// `performance.now()` captured at construction time.
    timestamp: f64,
    /// `null` until dispatch, then the target the event was dispatched
    /// on. `target`/`srcElement` both read from here.
    target: RefCell<Option<v8::Global<v8::Object>>>,
    /// `CustomEvent.detail`; `None` on a plain `Event`.
    detail: RefCell<Option<v8::Global<v8::Value>>>,
}

/// Check `obj` is an `Event`/`CustomEvent` instance (field 0 = External).
fn is_event_instance(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>) -> bool {
    native::is::<EventInternal>(scope, obj, 0)
}

/// Read back the `EventInternal` stored at field 0. Lifetime widened to
/// `'a` matches `native::get`'s signature — sound for the same reason
/// it is in `URL`/`Headers` (boxed state lives as long as the V8
/// object; this is a single-threaded runtime).
fn event_state<'a>(
    scope: &mut v8::PinScope,
    obj: v8::Local<v8::Object>,
) -> &'a EventInternal {
    let state: &EventInternal = native::get(scope, obj, 0);
    state
}

/// A single registered listener on an `EventTarget`.
struct Listener {
    callback: v8::Global<v8::Function>,
    once: bool,
    /// Stored per spec; no-op here (no capture phase — no tree).
    capture: bool,
    /// If set, the listener is auto-removed when this signal aborts.
    /// Strong `Global<Object>` (fine for this runtime's lifetime model).
    signal: Option<v8::Global<v8::Object>>,
    /// Identity of the abort-listener we registered on `signal` (so a
    /// normal `removeEventListener` can also detach the abort handler,
    /// avoiding a dangling handler firing into a removed listener).
    signal_callback: Option<v8::Global<v8::Function>>,
}

/// Per-`EventTarget`/`AbortSignal` state: the listener map, keyed by
/// event type. Wrapped in `Rc<RefCell<…>>` so abort-signal cleanup
/// (which fires from a listener callback on a *different* target) can
/// mutate the same map without double-borrowing the holder's field.
struct EventTargetInternal {
    listeners: Rc<RefCell<HashMap<String, Vec<Listener>>>>,
    /// `on<event>` handler attributes (DOM §2.11). Maps event type →
    /// the user-set handler function (or `None` if set to null). The
    /// wrapper listener registered via `addEventListener` reads this
    /// map to find the current handler on each dispatch.
    handlers: Rc<RefCell<HashMap<String, Option<v8::Global<v8::Function>>>>>,
}

fn is_event_target_instance(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>) -> bool {
    native::is::<EventTargetInternal>(scope, obj, 0)
}

fn target_state<'a>(
    scope: &mut v8::PinScope,
    obj: v8::Local<v8::Object>,
) -> &'a EventTargetInternal {
    let state: &EventTargetInternal = native::get(scope, obj, 0);
    state
}

/// Per-`AbortSignal` extra state (field 1). `AbortSignal` extends
/// `EventTarget`, so field 0 is the inherited listener map.
struct SignalInternal {
    aborted: Cell<bool>,
    reason: RefCell<Option<v8::Global<v8::Value>>>,
}

fn signal_state<'a>(
    scope: &mut v8::PinScope,
    obj: v8::Local<v8::Object>,
) -> &'a SignalInternal {
    let state: &SignalInternal = native::get(scope, obj, 1);
    state
}

fn is_signal_instance(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>) -> bool {
    native::is::<SignalInternal>(scope, obj, 1)
}

// =========================================================================
// Install
// =========================================================================

// Templates cached in thread-locals so static methods (`timeout`/`any`)
// and cross-target dispatch (abort → remove listener, `performance`
// singleton construction) can mint fresh instances without re-fetching
// the global constructor off `globalThis` each call. Set once during
// `install`.
thread_local! {
    static EVENT_TMPL: RefCell<Option<v8::Global<v8::FunctionTemplate>>> = const { RefCell::new(None) };
    static EVENT_TARGET_TMPL: RefCell<Option<v8::Global<v8::FunctionTemplate>>> = const { RefCell::new(None) };
    static CUSTOM_EVENT_TMPL: RefCell<Option<v8::Global<v8::FunctionTemplate>>> = const { RefCell::new(None) };
    static ABORT_SIGNAL_TMPL: RefCell<Option<v8::Global<v8::FunctionTemplate>>> = const { RefCell::new(None) };

    /// Id counters + data tables for the native trampolines (signal-remove,
    /// timeout-abort, any-abort). Each trampoline carries its id in the
    /// V8 function's `data` slot; the trampoline looks the id up here to
    /// recover the captured `Global` handles. Entries are one-shot
    /// (removed on first fire).
    static NEXT_TRAMP_ID: Cell<usize> = const { Cell::new(0) };
    static SIG_REMOVERS: RefCell<HashMap<usize, SignalRemoverData>> = RefCell::new(HashMap::new());
    static TMO_ABORTS: RefCell<HashMap<usize, v8::Global<v8::Object>>> = RefCell::new(HashMap::new());
    static ANY_ABORTS: RefCell<HashMap<usize, v8::Global<v8::Object>>> = RefCell::new(HashMap::new());

    /// Per-id data for the `on<event>` handler wrapper trampoline. The
    /// trampoline is a native `Function` registered as a normal
    /// `addEventListener` listener; when the event fires, it looks up the
    /// current handler from the target's `handlers` map and calls it.
    /// The event type is recovered from the V8 `info.data()` slot.
    static ON_EVENT_WRAPPERS: RefCell<HashMap<usize, OnEventWrapperData>> = RefCell::new(HashMap::new());
}

/// Per-id data for the `addEventListener({signal})` auto-remove
/// trampoline. Lives at module level (not inside the function) so both
/// `make_signal_remove_callback` (insert) and `signal_remove_trampoline`
/// (remove) share the same `SIG_REMOVERS` table.
struct SignalRemoverData {
    target: v8::Global<v8::Object>,
    type_: v8::Global<v8::Value>,
    callback: v8::Global<v8::Function>,
    capture: bool,
}

/// Per-id data for the `on<event>` handler wrapper trampoline. Stores
/// the target object and event type so the wrapper can look up the
/// current handler from the target's `handlers` map and invoke it.
#[derive(Clone)]
struct OnEventWrapperData {
    target: v8::Global<v8::Object>,
    type_: String,
}

/// Mint a fresh one-shot trampoline id (shared counter across all three
/// trampoline tables — ids are unique across tables because the data
/// slot only carries the id, and each table is keyed by id alone, so a
/// shared counter keeps them disjoint by construction).
fn next_tramp_id() -> usize {
    NEXT_TRAMP_ID.with(|c| {
        let id = c.get();
        c.set(id.wrapping_add(1));
        id
    })
}

pub fn install(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    // Order matters: parent templates must be created before children
    // call `inherit`. `Event` before `CustomEvent`; `EventTarget` before
    // `AbortSignal`/`AbortController`.
    let event_tmpl = build_event_template(scope);
    let event_target_tmpl = build_event_target_template(scope);

    let custom_event_tmpl = build_custom_event_template(scope, event_tmpl);
    let abort_signal_tmpl = build_abort_signal_template(scope, event_target_tmpl);
    let abort_controller_tmpl = build_abort_controller_template(scope);

    // Cache the templates so static methods can mint fresh instances.
    EVENT_TMPL.with(|c| *c.borrow_mut() = Some(v8::Global::new(scope, event_tmpl)));
    EVENT_TARGET_TMPL.with(|c| *c.borrow_mut() = Some(v8::Global::new(scope, event_target_tmpl)));
    CUSTOM_EVENT_TMPL.with(|c| *c.borrow_mut() = Some(v8::Global::new(scope, custom_event_tmpl)));
    ABORT_SIGNAL_TMPL.with(|c| *c.borrow_mut() = Some(v8::Global::new(scope, abort_signal_tmpl)));

    let event_ctor = event_tmpl.get_function(scope).unwrap();
    let event_target_ctor = event_target_tmpl.get_function(scope).unwrap();
    let custom_event_ctor = custom_event_tmpl.get_function(scope).unwrap();
    let abort_signal_ctor = abort_signal_tmpl.get_function(scope).unwrap();
    let abort_controller_ctor = abort_controller_tmpl.get_function(scope).unwrap();

    crate::web::set_global(scope, global, "Event", event_ctor.into());
    crate::web::set_global(scope, global, "EventTarget", event_target_ctor.into());
    crate::web::set_global(scope, global, "CustomEvent", custom_event_ctor.into());
    crate::web::set_global(scope, global, "AbortSignal", abort_signal_ctor.into());
    crate::web::set_global(scope, global, "AbortController", abort_controller_ctor.into());

    // Static methods live on the constructor function object.
    set_static_method(scope, abort_signal_ctor, "abort", signal_abort_static);
    set_static_method(scope, abort_signal_ctor, "timeout", signal_timeout);
    set_static_method(scope, abort_signal_ctor, "any", signal_any);
}

// --- Event template ------------------------------------------------------

fn build_event_template<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::FunctionTemplate> {
    let tmpl = v8::FunctionTemplate::new(scope, event_constructor);
    tmpl.set_class_name(v8::String::new(scope, "Event").unwrap());
    tmpl.instance_template(scope).set_internal_field_count(1);

    let instance = tmpl.instance_template(scope);
    set_readonly_accessor(scope, instance, "type", event_get_type);
    set_readonly_accessor(scope, instance, "target", event_get_target);
    set_readonly_accessor(scope, instance, "srcElement", event_get_target);
    set_readonly_accessor(scope, instance, "bubbles", event_get_bubbles);
    set_readonly_accessor(scope, instance, "cancelable", event_get_cancelable);
    set_readonly_accessor(scope, instance, "composed", event_get_composed);
    set_readonly_accessor(scope, instance, "defaultPrevented", event_get_default_prevented);
    set_readonly_accessor(scope, instance, "timeStamp", event_get_timestamp);
    set_readonly_accessor(scope, instance, "isTrusted", event_get_is_trusted);

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "preventDefault", event_prevent_default);
    set_method(scope, proto, "stopPropagation", event_stop_propagation);
    set_method(scope, proto, "stopImmediatePropagation", event_stop_immediate);
    tmpl
}

// --- CustomEvent template ------------------------------------------------

fn build_custom_event_template<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    event_tmpl: v8::Local<v8::FunctionTemplate>,
) -> v8::Local<'s, v8::FunctionTemplate> {
    let tmpl = v8::FunctionTemplate::new(scope, custom_event_constructor);
    tmpl.set_class_name(v8::String::new(scope, "CustomEvent").unwrap());
    // Wires `CustomEvent.prototype.__proto__ = Event.prototype`.
    tmpl.inherit(event_tmpl);
    tmpl.instance_template(scope).set_internal_field_count(1);

    let instance = tmpl.instance_template(scope);
    set_readonly_accessor(scope, instance, "detail", custom_event_get_detail);

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "initCustomEvent", custom_event_init);
    tmpl
}

// --- EventTarget template ------------------------------------------------

fn build_event_target_template<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::FunctionTemplate> {
    let tmpl = v8::FunctionTemplate::new(scope, event_target_constructor);
    tmpl.set_class_name(v8::String::new(scope, "EventTarget").unwrap());
    tmpl.instance_template(scope).set_internal_field_count(1);

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "addEventListener", event_target_add);
    set_method(scope, proto, "removeEventListener", event_target_remove);
    set_method(scope, proto, "dispatchEvent", event_target_dispatch);
    tmpl
}

// --- AbortSignal template ------------------------------------------------

fn build_abort_signal_template<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    event_target_tmpl: v8::Local<'s, v8::FunctionTemplate>,
) -> v8::Local<'s, v8::FunctionTemplate> {
    let tmpl = v8::FunctionTemplate::new(scope, signal_constructor);
    tmpl.set_class_name(v8::String::new(scope, "AbortSignal").unwrap());
    // `AbortSignal : EventTarget` — field 0 is the inherited listener
    // map; field 1 is signal-specific state.
    tmpl.inherit(event_target_tmpl);
    tmpl.instance_template(scope).set_internal_field_count(2);

    let instance = tmpl.instance_template(scope);
    set_readonly_accessor(scope, instance, "aborted", signal_get_aborted);
    set_readonly_accessor(scope, instance, "reason", signal_get_reason);
    // DOM §2.11: `onabort` event handler attribute on AbortSignal.
    let onabort_key = v8::String::new(scope, "onabort").unwrap();
    let abort_data = v8::String::new(scope, "abort").unwrap();
    let config = v8::AccessorConfiguration::new(on_event_getter)
        .setter(on_event_setter)
        .data(abort_data.into());
    instance.set_accessor_with_configuration(onabort_key.into(), config);

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "throwIfAborted", signal_throw_if_aborted);
    tmpl
}

// --- AbortController template --------------------------------------------

fn build_abort_controller_template<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::FunctionTemplate> {
    let tmpl = v8::FunctionTemplate::new(scope, controller_constructor);
    tmpl.set_class_name(v8::String::new(scope, "AbortController").unwrap());
    tmpl.instance_template(scope).set_internal_field_count(1);

    let instance = tmpl.instance_template(scope);
    set_readonly_accessor(scope, instance, "signal", controller_get_signal);

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "abort", controller_abort);
    tmpl
}

// =========================================================================
// Event
// =========================================================================

fn event_constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !args.is_construct_call() {
        crate::web::throw_type_error(scope, "Failed to construct 'Event': Please use the 'new' operator");
        return;
    }
    let type_ = if args.length() > 0 && !args.get(0).is_undefined() {
        args.get(0).to_rust_string_lossy(scope)
    } else {
        String::new()
    };
    let (bubbles, cancelable, composed) = parse_event_init(scope, args.get(1));
    let timestamp = crate::web::performance::now_value();

    let this = args.this();
    native::store(
        scope,
        this,
        0,
        EventInternal {
            type_: RefCell::new(type_),
            bubbles: Cell::new(bubbles),
            cancelable: Cell::new(cancelable),
            composed: Cell::new(composed),
            default_prevented: Cell::new(false),
            stop_immediate: Cell::new(false),
            is_trusted: Cell::new(false),
            timestamp,
            target: RefCell::new(None),
            detail: RefCell::new(None),
        },
    );
    rv.set(this.into());
}

/// Read `bubbles`/`cancelable`/`composed` from an `EventInit`-shaped
/// argument. Accepts `undefined`/`null` (all default `false`) or a
/// plain object. Anything else is treated as all-false (matches
/// browsers, which coerce non-objects to {} here).
fn parse_event_init(scope: &mut v8::PinScope, init: v8::Local<v8::Value>) -> (bool, bool, bool) {
    if init.is_null_or_undefined() {
        return (false, false, false);
    }
    let Ok(obj) = <v8::Local<v8::Object>>::try_from(init) else {
        return (false, false, false);
    };
    (
        get_bool(scope, obj, "bubbles"),
        get_bool(scope, obj, "cancelable"),
        get_bool(scope, obj, "composed"),
    )
}

fn event_get_type(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let s = event_state(scope, args.holder()).type_.borrow().clone();
    rv.set(v8::String::new(scope, &s).unwrap().into());
}

fn event_get_target(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let target = event_state(scope, args.holder()).target.borrow();
    match target.as_ref() {
        Some(g) => rv.set(v8::Local::new(scope, g).into()),
        None => rv.set(v8::null(scope).into()),
    }
}

fn event_get_bubbles(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let v = event_state(scope, args.holder()).bubbles.get();
    rv.set(v8::Boolean::new(scope, v).into());
}

fn event_get_cancelable(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let v = event_state(scope, args.holder()).cancelable.get();
    rv.set(v8::Boolean::new(scope, v).into());
}

fn event_get_composed(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let v = event_state(scope, args.holder()).composed.get();
    rv.set(v8::Boolean::new(scope, v).into());
}

fn event_get_default_prevented(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let v = event_state(scope, args.holder()).default_prevented.get();
    rv.set(v8::Boolean::new(scope, v).into());
}

fn event_get_timestamp(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let v = event_state(scope, args.holder()).timestamp;
    rv.set(v8::Number::new(scope, v).into());
}

fn event_get_is_trusted(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let v = event_state(scope, args.holder()).is_trusted.get();
    rv.set(v8::Boolean::new(scope, v).into());
}

fn event_prevent_default(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    event_state(scope, args.this()).default_prevented.set(true);
}

fn event_stop_propagation(
    _scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    // No-op: single target, no propagation tree (see module doc comment).
}

fn event_stop_immediate(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    event_state(scope, args.this()).stop_immediate.set(true);
}

// =========================================================================
// CustomEvent
// =========================================================================

fn custom_event_constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !args.is_construct_call() {
        crate::web::throw_type_error(scope, "Failed to construct 'CustomEvent': Please use the 'new' operator");
        return;
    }
    let type_ = if args.length() > 0 && !args.get(0).is_undefined() {
        args.get(0).to_rust_string_lossy(scope)
    } else {
        String::new()
    };
    let (bubbles, cancelable, composed) = parse_event_init(scope, args.get(1));
    let detail = parse_custom_event_init_detail(scope, args.get(1));
    let timestamp = crate::web::performance::now_value();

    let this = args.this();
    native::store(
        scope,
        this,
        0,
        EventInternal {
            type_: RefCell::new(type_),
            bubbles: Cell::new(bubbles),
            cancelable: Cell::new(cancelable),
            composed: Cell::new(composed),
            default_prevented: Cell::new(false),
            stop_immediate: Cell::new(false),
            is_trusted: Cell::new(false),
            timestamp,
            target: RefCell::new(None),
            detail: RefCell::new(Some(v8::Global::new(scope, detail))),
        },
    );
    rv.set(this.into());
}

/// Pull `detail` out of a `CustomEventInit` (default `null` per spec).
fn parse_custom_event_init_detail<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    init: v8::Local<v8::Value>,
) -> v8::Local<'s, v8::Value> {
    if init.is_null_or_undefined() {
        return v8::null(scope).into();
    }
    let Ok(obj) = <v8::Local<v8::Object>>::try_from(init) else {
        return v8::null(scope).into();
    };
    let key = v8::String::new(scope, "detail").unwrap();
    match obj.get(scope, key.into()) {
        Some(v) if !v.is_undefined() => v,
        _ => v8::null(scope).into(),
    }
}

fn custom_event_get_detail(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let detail = event_state(scope, args.holder()).detail.borrow();
    match detail.as_ref() {
        Some(g) => rv.set(v8::Local::new(scope, g).into()),
        // A plain `Event` reached this accessor somehow (shouldn't happen
        // unless someone shuffles prototypes); spec says `detail` is only
        // on `CustomEvent`, so return `undefined`.
        None => rv.set(v8::undefined(scope).into()),
    }
}

/// `initCustomEvent(type, bubbles, cancelable, detail)` — deprecated
/// legacy init. Browsers no-op it (the fields are set at construction
/// time only); we match by storing the values. Kept as a method so
/// feature-detection (`"initCustomEvent" in event`) works.
fn custom_event_init(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let state = event_state(scope, args.this());
    if args.length() > 0 && !args.get(0).is_undefined() {
        *state.type_.borrow_mut() = args.get(0).to_rust_string_lossy(scope);
    }
    state.bubbles.set(args.length() > 1 && args.get(1).boolean_value(scope));
    state.cancelable.set(args.length() > 2 && args.get(2).boolean_value(scope));
    *state.detail.borrow_mut() = Some(v8::Global::new(
        scope,
        if args.length() > 3 { args.get(3) } else { v8::null(scope).into() },
    ));
}

// =========================================================================
// EventTarget
// =========================================================================

fn event_target_constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !args.is_construct_call() {
        crate::web::throw_type_error(scope, "Failed to construct 'EventTarget': Please use the 'new' operator");
        return;
    }
    let this = args.this();
    native::store(
        scope,
        this,
        0,
        EventTargetInternal {
            listeners: Rc::new(RefCell::new(HashMap::new())),
            handlers: Rc::new(RefCell::new(HashMap::new())),
        },
    );
    rv.set(this.into());
}

fn event_target_add(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let this = args.this();
    if !is_event_target_instance(scope, this) {
        // Subclass constructed without calling super(): no state yet.
        // Spec would throw; we no-op to match `URL`-style tolerance.
        return;
    }
    let type_ = args.get(0).to_rust_string_lossy(scope);
    let Ok(callback): Result<v8::Local<v8::Function>, _> = args.get(1).try_into() else {
        // `null`/`undefined`/non-function: spec says no-op.
        return;
    };
    let (capture, once, signal) = parse_add_options(scope, args.get(2));

    let state = target_state(scope, this);
    let callback_global = v8::Global::new(scope, callback);
    {
        let mut map = state.listeners.borrow_mut();
        let list = map.entry(type_.clone()).or_default();
        // Dedup: same (callback, capture) is a no-op (spec §2.9 step 11).
        if list.iter().any(|l| same_function(&l.callback, &callback_global) && l.capture == capture) {
            return;
        }
        list.push(Listener {
            callback: callback_global.clone(),
            once,
            capture,
            signal: signal.map(|s| v8::Global::new(scope, s)),
            signal_callback: None,
        });
    }

    // Wire the `signal` option: register an `"abort"` listener on the
    // signal that removes this listener from `this` when it fires.
    if let Some(signal_obj) = signal {
        if let Some(remove_cb) = make_signal_remove_callback(scope, this, type_.clone(), callback_global.clone(), capture) {
            // Record the abort-listener callback identity so a later
            // `removeEventListener` on `this` can also unregister the
            // abort handler (avoids a dangling handler firing into a
            // removed listener).
            let state = target_state(scope, this);
            let mut map = state.listeners.borrow_mut();
            if let Some(list) = map.get_mut(&type_) {
                for l in list.iter_mut() {
                    if same_function(&l.callback, &callback_global) && l.capture == capture {
                        l.signal_callback = Some(v8::Global::new(scope, remove_cb));
                        break;
                    }
                }
            }
            drop(map);
            // Actually attach the abort listener on the signal.
            add_listener_internal(scope, signal_obj, "abort", remove_cb, false, false);
        }
    }
}

fn event_target_remove(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let this = args.this();
    if !is_event_target_instance(scope, this) {
        return;
    }
    let type_ = args.get(0).to_rust_string_lossy(scope);
    let Ok(callback): Result<v8::Local<v8::Function>, _> = args.get(1).try_into() else {
        return;
    };
    let (capture, _once, _signal) = parse_add_options(scope, args.get(2));
    remove_listener_internal(scope, this, &type_, callback, capture);
}

fn event_target_dispatch(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let this = args.this();
    let event_arg = args.get(0);
    let Ok(event_obj) = <v8::Local<v8::Object>>::try_from(event_arg) else {
        crate::web::throw_dom_exception(scope, "InvalidStateError", "dispatchEvent: argument is not an Event");
        return;
    };
    if !is_event_instance(scope, event_obj) {
        crate::web::throw_dom_exception(scope, "InvalidStateError", "dispatchEvent: argument is not an Event");
        return;
    }
    if !is_event_target_instance(scope, this) {
        // No listener state → nothing to do; spec returns true.
        rv.set(v8::Boolean::new(scope, true).into());
        return;
    }

    dispatch_internal(scope, this, event_obj);
    rv.set(v8::Boolean::new(scope, true).into());
}

/// Shared dispatch body — used by the JS-exposed `dispatchEvent` and by
/// `abort_signal` (which dispatches an `"abort"` event on the signal
/// from native code). Sets `event.target`, iterates the snapshot of
/// listeners for the event's type, calls each, honors
/// `stopImmediatePropagation`, and auto-removes `once` listeners.
fn dispatch_internal(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::Object>,
    event: v8::Local<v8::Object>,
) {
    // Set `event.target = this` (and `srcElement`, same field).
    {
        let state = event_state(scope, event);
        *state.target.borrow_mut() = Some(v8::Global::new(scope, target));
        state.stop_immediate.set(false);
    }

    let type_ = event_state(scope, event).type_.borrow().clone();
    let state = target_state(scope, target);
    let snapshot: Vec<(v8::Global<v8::Function>, bool)> = {
        let map = state.listeners.borrow();
        match map.get(&type_) {
            Some(list) => list.iter().map(|l| (l.callback.clone(), l.once)).collect(),
            None => Vec::new(),
        }
    };

    for (cb_global, once) in snapshot {
        // `stopImmediatePropagation` was called by a previous listener
        // on this same target — stop now.
        if event_state(scope, event).stop_immediate.get() {
            break;
        }
        // Skip if the listener was removed between snapshots (user code
        // in a prior handler called `removeEventListener`).
        let still_registered = {
            let map = state.listeners.borrow();
            map.get(&type_)
                .map(|list| list.iter().any(|l| same_function(&l.callback, &cb_global)))
                .unwrap_or(false)
        };
        if !still_registered {
            continue;
        }

        let cb = v8::Local::new(scope, &cb_global);
        let argv = [event.into()];
        // Per DOM §2.9 "inner invoke", an exception thrown by a listener is
        // *reported* (to the error handler / console), not propagated out of
        // dispatch — otherwise a throwing listener would leave a pending V8
        // exception that corrupts the rest of the loop, and (for native-
        // initiated dispatch like `controller.abort()`) surface at the wrong
        // call site. Catch, report, and carry on to the next listener.
        {
            v8::tc_scope!(let tc, scope);
            let _ = cb.call(tc, target.into(), &argv);
            if tc.has_caught() {
                let msg = crate::core::exception::exception_text(tc);
                eprintln!("limun: Uncaught (in event listener) {msg}");
                tc.reset();
            }
        }

        if once {
            let mut map = state.listeners.borrow_mut();
            if let Some(list) = map.get_mut(&type_) {
                list.retain(|l| !same_function(&l.callback, &cb_global));
            }
        }
    }
}

// =========================================================================
// AbortController
// =========================================================================

/// Per-`AbortController` state: the signal it owns.
struct ControllerInternal {
    signal: v8::Global<v8::Object>,
}

fn controller_constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !args.is_construct_call() {
        crate::web::throw_type_error(scope, "Failed to construct 'AbortController': Please use the 'new' operator");
        return;
    }
    let signal = new_signal_instance(scope);
    let this = args.this();
    native::store(scope, this, 0, ControllerInternal { signal: v8::Global::new(scope, signal) });
    rv.set(this.into());
}

fn controller_get_signal(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &ControllerInternal = native::get(scope, args.holder(), 0);
    rv.set(v8::Local::new(scope, &state.signal).into());
}

fn controller_abort(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let this = args.this();
    let state: &ControllerInternal = native::get(scope, this, 0);
    let signal = v8::Local::new(scope, &state.signal);
    let reason = if args.length() > 0 && !args.get(0).is_undefined() {
        args.get(0)
    } else {
        // Default reason: an `Error` with `.name = "AbortError"` (no
        // real DOMException — matches `throw_dom_exception` pattern).
        make_named_error(scope, "AbortError", "signal is aborted without reason")
    };
    abort_signal(scope, signal, reason);
}

// =========================================================================
// AbortSignal
// =========================================================================

fn signal_constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !args.is_construct_call() {
        crate::web::throw_type_error(scope, "Failed to construct 'AbortSignal': Please use the 'new' operator");
        return;
    }
    let this = args.this();
    // Field 0: inherited EventTarget listener map.
    native::store(
        scope,
        this,
        0,
        EventTargetInternal {
            listeners: Rc::new(RefCell::new(HashMap::new())),
            handlers: Rc::new(RefCell::new(HashMap::new())),
        },
    );
    // Field 1: signal-specific state.
    native::store(
        scope,
        this,
        1,
        SignalInternal {
            aborted: Cell::new(false),
            reason: RefCell::new(None),
        },
    );
    rv.set(this.into());
}

fn signal_get_aborted(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !is_signal_instance(scope, args.holder()) {
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    }
    let v = signal_state(scope, args.holder()).aborted.get();
    rv.set(v8::Boolean::new(scope, v).into());
}

fn signal_get_reason(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !is_signal_instance(scope, args.holder()) {
        rv.set(v8::undefined(scope).into());
        return;
    }
    let reason = signal_state(scope, args.holder()).reason.borrow();
    match reason.as_ref() {
        Some(g) => rv.set(v8::Local::new(scope, g).into()),
        None => rv.set(v8::undefined(scope).into()),
    }
}

fn signal_throw_if_aborted(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    if !is_signal_instance(scope, args.this()) {
        return;
    }
    let this = args.this();
    if !signal_state(scope, this).aborted.get() {
        return;
    }
    let reason = signal_state(scope, this).reason.borrow();
    let reason_local = reason.as_ref().map(|g| v8::Local::new(scope, g));
    // Per spec, `throwIfAborted()` performs `throw this.reason` — the reason
    // is thrown as-is, whatever its type (a string reason throws the string,
    // not an Error wrapping it). Only the never-happens no-reason case
    // synthesizes a fallback.
    match reason_local {
        Some(v) => {
            scope.throw_exception(v);
        }
        None => {
            let exc = make_named_error(scope, "AbortError", "signal aborted");
            scope.throw_exception(exc);
        }
    }
}

/// `AbortSignal.abort(reason?)` — static. Returns an already-aborted
/// signal with the given (or default AbortError) reason.
fn signal_abort_static(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let signal = new_signal_instance(scope);
    let reason = if args.length() > 0 && !args.get(0).is_undefined() {
        args.get(0)
    } else {
        make_named_error(scope, "AbortError", "signal is aborted without reason")
    };
    abort_signal(scope, signal, reason);
    rv.set(signal.into());
}

/// `AbortSignal.timeout(ms)` — static. Returns a signal that aborts
/// with a `TimeoutError`-named `Error` after `ms` milliseconds.
fn signal_timeout(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let ms = if args.length() > 0 {
        args.get(0).number_value(scope).unwrap_or(0.0)
    } else {
        0.0
    };
    let signal = new_signal_instance(scope);
    let signal_global = v8::Global::new(scope, signal);

    // Schedule a setTimeout-style fire that calls abort_signal on the
    // signal with a TimeoutError-named Error. Reuses the timer wheel
    // (same path as `setTimeout`).
    let callback = make_timeout_abort_callback(scope, signal_global);
    let _id = crate::core::event_loop::schedule(callback, Vec::new(), ms, false);

    rv.set(signal.into());
}

/// Build a native `Function` (with `data` = a numeric id) that, when
/// called as an `"abort"` listener, aborts the cached signal with a
/// `TimeoutError`. The trampoline recovers the id via `args.data()`.
fn make_timeout_abort_callback(
    scope: &mut v8::PinScope,
    signal: v8::Global<v8::Object>,
) -> v8::Global<v8::Function> {
    let id = next_tramp_id();
    TMO_ABORTS.with(|m| {
        m.borrow_mut().insert(id, signal);
    });
    let id_val = v8::Number::new(scope, id as f64).into();
    let func = v8::Function::builder(timeout_abort_trampoline)
        .data(id_val)
        .build(scope)
        .unwrap();
    v8::Global::new(scope, func)
}

fn timeout_abort_trampoline(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let id = args.data().number_value(scope).map(|n| n as usize).unwrap_or(0);
    let signal = TMO_ABORTS.with(|m| m.borrow_mut().remove(&id));
    if let Some(signal_global) = signal {
        let signal = v8::Local::new(scope, &signal_global);
        let reason = make_named_error(scope, "TimeoutError", "signal timed out");
        abort_signal(scope, signal, reason);
    }
}

/// `AbortSignal.any(signals)` — static. Returns a new signal that
/// aborts when *any* of the input signals aborts, with the same
/// reason. If any input is already aborted, the new signal aborts
/// immediately with that input's reason.
fn signal_any(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let new_signal = new_signal_instance(scope);
    let new_signal_global = v8::Global::new(scope, new_signal);

    let Ok(arr) = <v8::Local<v8::Array>>::try_from(args.get(0)) else {
        // Non-array input: spec throws. We no-op-return the new signal
        // (already-aborted=false) to stay tolerant — same bucket as
        // `addEventListener` with a non-function.
        rv.set(new_signal.into());
        return;
    };

    for i in 0..arr.length() {
        if let Some(elem) = arr.get_index(scope, i) {
            let Ok(sig_obj) = <v8::Local<v8::Object>>::try_from(elem) else {
                continue;
            };
            if !is_signal_instance(scope, sig_obj) {
                continue;
            }
            if signal_state(scope, sig_obj).aborted.get() {
                // Already aborted — abort the new signal immediately
                // with this input's reason and return.
                let reason = {
                    let r = signal_state(scope, sig_obj).reason.borrow();
                    r.as_ref()
                        .map(|g| v8::Local::new(scope, g))
                        .unwrap_or_else(|| v8::undefined(scope).into())
                };
                abort_signal(scope, new_signal, reason);
                rv.set(new_signal.into());
                return;
            }
            // Register an `"abort"` listener on this input that aborts
            // the new signal (with the input's current reason) when it
            // fires. One-shot — `any` only needs the first.
            let cb = make_any_abort_callback(scope, new_signal_global.clone());
            add_listener_internal(scope, sig_obj, "abort", cb, false, true);
        }
    }

    rv.set(new_signal.into());
}

/// Build a native `Function` (with `data` = numeric id) for the
/// `AbortSignal.any` dependent-abort listener. The trampoline reads
/// the source signal's reason off the `"abort"` event's `.target` and
/// aborts the cached dependent signal with it.
fn make_any_abort_callback<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    target_signal: v8::Global<v8::Object>,
) -> v8::Local<'s, v8::Function> {
    let id = next_tramp_id();
    ANY_ABORTS.with(|m| {
        m.borrow_mut().insert(id, target_signal);
    });
    let id_val = v8::Number::new(scope, id as f64).into();
    v8::Function::builder(any_abort_trampoline)
        .data(id_val)
        .build(scope)
        .unwrap()
}

fn any_abort_trampoline(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    // The event argument is the `"abort"` event fired on the source
    // signal. The source signal is `event.target`. Read its `reason`
    // and abort the dependent (new) signal with it.
    let source_signal = <v8::Local<v8::Object>>::try_from(args.get(0))
        .ok()
        .and_then(|e| {
            let key = v8::String::new(scope, "target").unwrap();
            <v8::Local<v8::Object>>::try_from(e.get(scope, key.into())?).ok()
        });

    let id = args.data().number_value(scope).map(|n| n as usize).unwrap_or(0);
    let target = ANY_ABORTS.with(|m| m.borrow_mut().remove(&id));

    if let (Some(target_signal), Some(source)) = (target, source_signal) {
        let reason = if is_signal_instance(scope, source) {
            let r = signal_state(scope, source).reason.borrow();
            r.as_ref()
                .map(|g| v8::Local::new(scope, g))
                .unwrap_or_else(|| v8::undefined(scope).into())
        } else {
            v8::undefined(scope).into()
        };
        let target_local = v8::Local::new(scope, &target_signal);
        abort_signal(scope, target_local, reason);
    }
}

// =========================================================================
// on<event> handler attributes (DOM §2.11)
// =========================================================================

/// Getter for `on<event>` properties: returns the current handler (or
/// `null` if none). The event type is passed via `info.data()` (a
/// string).
fn on_event_getter(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let this = args.holder();
    if !is_event_target_instance(scope, this) {
        rv.set(v8::null(scope).into());
        return;
    }
    let data = args.data();
    let type_ = data.to_rust_string_lossy(scope);
    let state = target_state(scope, this);
    let handler = state.handlers.borrow().get(&type_).cloned().flatten();
    match handler {
        Some(g) => rv.set(v8::Local::new(scope, &g).into()),
        None => rv.set(v8::null(scope).into()),
    }
}

/// Setter for `on<event>` properties: stores the handler and registers
/// a wrapper listener via `addEventListener` on first set. Subsequent
/// sets just update the stored handler (the wrapper reads it from the
/// `handlers` map on each dispatch, so no remove/re-add churn).
fn on_event_setter(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    value: v8::Local<v8::Value>,
    args: v8::PropertyCallbackArguments,
    _rv: v8::ReturnValue<()>,
) {
    let this = args.holder();
    if !is_event_target_instance(scope, this) {
        return;
    }
    let handler: Option<v8::Global<v8::Function>> = if value.is_function() {
        let func: v8::Local<v8::Function> = value.try_into().unwrap();
        Some(v8::Global::new(scope, func))
    } else {
        None
    };

    let data = args.data();
    let type_ = data.to_rust_string_lossy(scope);

    let state = target_state(scope, this);
    let already_registered = state.handlers.borrow().contains_key(&type_);
    state.handlers.borrow_mut().insert(type_.clone(), handler.clone());

    if !already_registered && handler.is_some() {
        let wrapper = make_on_event_wrapper(scope, this, &type_);
        if let Some(wrapper_fn) = wrapper {
            add_listener_internal(scope, this, &type_, wrapper_fn, false, false);
        }
    }
}

/// Build a native `Function` trampoline for the `on<event>` wrapper.
/// When the event fires, this trampoline looks up the current handler
/// from the target's `handlers` map and invokes it with the event.
fn make_on_event_wrapper<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    target: v8::Local<v8::Object>,
    type_: &str,
) -> Option<v8::Local<'s, v8::Function>> {
    let id = next_tramp_id();
    ON_EVENT_WRAPPERS.with(|m| {
        m.borrow_mut().insert(
            id,
            OnEventWrapperData {
                target: v8::Global::new(scope, target),
                type_: type_.to_string(),
            },
        );
    });
    let id_val = v8::Number::new(scope, id as f64).into();
    let func = v8::Function::builder(on_event_wrapper_trampoline)
        .data(id_val)
        .build(scope)?;
    Some(func)
}

/// Trampoline for `on<event>` handler dispatch. Reads the current
/// handler from the target's `handlers` map and calls it with the event.
fn on_event_wrapper_trampoline(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let id = args.data().number_value(scope).map(|n| n as usize).unwrap_or(0);
    let data = ON_EVENT_WRAPPERS.with(|m| m.borrow().get(&id).cloned());
    let Some(data) = data else { return };
    let target = v8::Local::new(scope, &data.target);
    if !is_event_target_instance(scope, target) {
        return;
    }
    let state = target_state(scope, target);
    let handler = state.handlers.borrow().get(&data.type_).cloned().flatten();
    let Some(handler_global) = handler else { return };
    let handler_local = v8::Local::new(scope, &handler_global);
    let event_arg = args.get(0);
    // Call the handler with `this` = target, event as argument.
    {
        v8::tc_scope!(let tc, scope);
        let _ = handler_local.call(tc, target.into(), &[event_arg]);
        if tc.has_caught() {
            let msg = crate::core::exception::exception_text(tc);
            eprintln!("limun: Uncaught (in event handler) {msg}");
            tc.reset();
        }
    }
}

// =========================================================================
// Shared signal logic
// =========================================================================

/// Core abort algorithm (shared by `controller.abort`, `signal.timeout`'s
/// fire, and `signal.any`'s dependent-abort). If already aborted, no-op.
/// Otherwise: set `aborted = true`, set `reason`, dispatch an `"abort"`
/// event on the signal.
fn abort_signal(
    scope: &mut v8::PinScope,
    signal: v8::Local<v8::Object>,
    reason: v8::Local<v8::Value>,
) {
    if !is_signal_instance(scope, signal) {
        return;
    }
    let state = signal_state(scope, signal);
    if state.aborted.get() {
        return;
    }
    state.aborted.set(true);
    *state.reason.borrow_mut() = Some(v8::Global::new(scope, reason));

    // Dispatch a plain `Event("abort")` on the signal via the inherited
    // EventTarget machinery. Per spec, abort events are trusted (fired by
    // the user agent, not by script).
    let event = new_event_instance(scope, "abort");
    if is_event_target_instance(scope, signal) {
        // Mark the event as trusted (isTrusted = true) since it was
        // dispatched by the runtime, not by user script.
        if is_event_instance(scope, event) {
            event_state(scope, event).is_trusted.set(true);
        }
        dispatch_internal(scope, signal, event);
    }
}

/// Internal `addEventListener` — no option parsing, used by the abort
/// wiring (signal-remove, any-abort) where the listener is a native
/// trampoline with `once`/`capture` known up front.
fn add_listener_internal(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::Object>,
    type_: &str,
    callback: v8::Local<v8::Function>,
    capture: bool,
    once: bool,
) {
    if !is_event_target_instance(scope, target) {
        return;
    }
    let state = target_state(scope, target);
    let mut map = state.listeners.borrow_mut();
    let list = map.entry(type_.to_string()).or_default();
    let callback_global = v8::Global::new(scope, callback);
    if list.iter().any(|l| same_function(&l.callback, &callback_global) && l.capture == capture) {
        return;
    }
    list.push(Listener {
        callback: callback_global,
        once,
        capture,
        signal: None,
        signal_callback: None,
    });
}

/// Internal `removeEventListener` — removes the first listener matching
/// `(callback, capture)`. Also unregisters the abort-signal handler
/// that was wired for this listener (if any) so it doesn't fire later
/// into a removed listener.
fn remove_listener_internal(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::Object>,
    type_: &str,
    callback: v8::Local<v8::Function>,
    capture: bool,
) {
    if !is_event_target_instance(scope, target) {
        return;
    }
    let state = target_state(scope, target);
    let mut map = state.listeners.borrow_mut();
    let Some(list) = map.get_mut(type_) else {
        return;
    };
    let callback_global = v8::Global::new(scope, callback);
    // Collect the abort-handler callback + signal to detach (if this
    // listener had a `signal` option wired).
    let mut to_detach: Option<v8::Global<v8::Function>> = None;
    let mut signal_obj: Option<v8::Global<v8::Object>> = None;
    list.retain(|l| {
        let matches = same_function(&l.callback, &callback_global) && l.capture == capture;
        if matches {
            to_detach = l.signal_callback.clone();
            signal_obj = l.signal.clone();
        }
        !matches
    });
    drop(map);

    // Detach the abort handler we registered on `signal` for this
    // listener, if any. Recursively removes on the *signal* target
    // (different target, different type, no cycle).
    if let (Some(sig), Some(cb)) = (signal_obj, to_detach) {
        let sig_local = v8::Local::new(scope, &sig);
        let cb_local = v8::Local::new(scope, &cb);
        remove_listener_internal(scope, sig_local, "abort", cb_local, false);
    }
}

// =========================================================================
// Signal-remove callback (for the `addEventListener` `signal` option)
// =========================================================================

/// Build a native `Function` (with `data` = numeric id) that, when
/// called as an `"abort"` listener on `signal`, removes the matching
/// listener from `target`. The trampoline recovers the id via
/// `args.data()` and the per-id data from a thread_local.
fn make_signal_remove_callback<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    target: v8::Local<v8::Object>,
    type_: String,
    callback: v8::Global<v8::Function>,
    capture: bool,
) -> Option<v8::Local<'s, v8::Function>> {
    let id = next_tramp_id();
    let type_str = v8::String::new(scope, &type_).unwrap();
    let type_val: v8::Local<v8::Value> = type_str.into();
    SIG_REMOVERS.with(|m| {
        m.borrow_mut().insert(
            id,
            SignalRemoverData {
                target: v8::Global::new(scope, target),
                type_: v8::Global::new(scope, type_val),
                callback,
                capture,
            },
        );
    });
    let id_val = v8::Number::new(scope, id as f64).into();
    let func = v8::Function::builder(signal_remove_trampoline)
        .data(id_val)
        .build(scope)?;
    Some(func)
}

fn signal_remove_trampoline(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let id = args.data().number_value(scope).map(|n| n as usize).unwrap_or(0);
    let data = SIG_REMOVERS.with(|m| m.borrow_mut().remove(&id));
    if let Some(data) = data {
        let target = v8::Local::new(scope, &data.target);
        if is_event_target_instance(scope, target) {
            let type_val = v8::Local::new(scope, &data.type_);
            let type_ = type_val.to_rust_string_lossy(scope);
            let cb = v8::Local::new(scope, &data.callback);
            remove_listener_internal(scope, target, &type_, cb, data.capture);
        }
    }
}

// =========================================================================
// Instance construction (from Rust — used by AbortController,
// AbortSignal.timeout/any, abort_signal's internal dispatch, and the
// `performance` singleton in `web::performance`)
// =========================================================================

/// Mint a fresh `Event` instance with a given `type`. Used by
/// `abort_signal` to dispatch a synthetic `"abort"` event.
fn new_event_instance<'s>(scope: &mut v8::PinScope<'s, '_>, type_: &str) -> v8::Local<'s, v8::Object> {
    let type_val = v8::String::new(scope, type_).unwrap();
    EVENT_TMPL.with(|c| {
        let tmpl_global = c.borrow().as_ref().unwrap().clone();
        let tmpl = v8::Local::new(scope, &tmpl_global);
        let ctor = tmpl.get_function(scope).unwrap();
        ctor.new_instance(scope, &[type_val.into()]).unwrap()
    })
}

/// Mint a fresh `AbortSignal` instance via the cached template. Used by
/// `AbortController`'s constructor and `AbortSignal.timeout`/`any`.
fn new_signal_instance<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Object> {
    ABORT_SIGNAL_TMPL.with(|c| {
        let tmpl_global = c.borrow().as_ref().unwrap().clone();
        let tmpl = v8::Local::new(scope, &tmpl_global);
        let ctor = tmpl.get_function(scope).unwrap();
        ctor.new_instance(scope, &[]).unwrap()
    })
}

/// Mint a fresh `EventTarget` instance via the cached template. Used by
/// `web::performance` to construct the `performance` singleton on top
/// of the `EventTarget` machinery (`Performance : EventTarget`).
pub fn new_event_target_instance<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Object> {
    EVENT_TARGET_TMPL.with(|c| {
        let tmpl_global = c.borrow().as_ref().unwrap().clone();
        let tmpl = v8::Local::new(scope, &tmpl_global);
        let ctor = tmpl.get_function(scope).unwrap();
        ctor.new_instance(scope, &[]).unwrap()
    })
}

// =========================================================================
// Helpers
// =========================================================================

/// Construct a real `DOMException` with the given `name`/`message`. Per the
/// DOM Standard, an `AbortController`'s default abort reason is an
/// `"AbortError"` DOMException and `AbortSignal.timeout()`'s is a
/// `"TimeoutError"` one — user code routinely checks
/// `e.name === "AbortError"` or `e instanceof DOMException`.
fn make_named_error<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    name: &str,
    message: &str,
) -> v8::Local<'s, v8::Value> {
    crate::web::dom_exception::new_instance(scope, name, message)
}

/// Read a boolean property off a JS object (default `false`).
fn get_bool(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, name: &str) -> bool {
    let key = v8::String::new(scope, name).unwrap();
    obj.get(scope, key.into())
        .map(|v| v.boolean_value(scope))
        .unwrap_or(false)
}

/// Parse the third arg to `addEventListener`/`removeEventListener`:
/// either a boolean (legacy `capture`) or an options object with
/// `capture`/`passive`/`once`/`signal`. Returns `(capture, once,
/// signal?)`. `passive` is parsed but discarded (no-op).
fn parse_add_options<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    options: v8::Local<v8::Value>,
) -> (bool, bool, Option<v8::Local<'s, v8::Object>>) {
    if options.is_boolean() {
        return (options.boolean_value(scope), false, None);
    }
    if options.is_null_or_undefined() {
        return (false, false, None);
    }
    let Ok(obj) = <v8::Local<v8::Object>>::try_from(options) else {
        return (false, false, None);
    };
    let capture = get_bool(scope, obj, "capture");
    let once = get_bool(scope, obj, "once");
    let signal = {
        let key = v8::String::new(scope, "signal").unwrap();
        match obj.get(scope, key.into()) {
            Some(v) if !v.is_null_or_undefined() => <v8::Local<v8::Object>>::try_from(v).ok(),
            _ => None,
        }
    };
    (capture, once, signal)
}

/// Identity-compare two `Global<Function>` handles. V8 globals are
/// compared by handle identity, so this is `==` on the globals.
fn same_function(a: &v8::Global<v8::Function>, b: &v8::Global<v8::Function>) -> bool {
    a == b
}

// --- template-install helpers (same shape as the ones in url.rs/
//     text_encoding.rs, kept local to avoid a `pub(crate)` churn) ---

fn set_method(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::ObjectTemplate>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    let func = v8::FunctionTemplate::new(scope, callback);
    target.set(key.into(), func.into());
}

fn set_static_method(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::Function>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    let func = v8::Function::new(scope, callback).unwrap();
    target.set(scope, key.into(), func.into());
}

fn set_readonly_accessor(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::ObjectTemplate>,
    name: &str,
    getter: impl v8::MapFnTo<v8::AccessorNameGetterCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    target.set_accessor(key.into(), getter);
}

// =========================================================================
// pub(crate) exports for fetch()'s AbortSignal integration
// =========================================================================

/// `true` iff `obj` is an `AbortSignal` instance and its `aborted` flag
/// is set. Used by `fetch()` to check the pre-aborted case (reject
/// immediately, before spawning) and by the abort-listener trampoline to
/// read the reason after abort fired.
pub(crate) fn is_aborted(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>) -> bool {
    is_signal_instance(scope, obj) && signal_state(scope, obj).aborted.get()
}

/// The abort reason for an aborted signal, as a `Local<Value>`. If the
/// signal is aborted but no reason was stored (the default-reason case
/// is actually always stored by `abort_signal` today, but this stays
/// robust against future changes), synthesize an `AbortError`-named
/// `Error` matching `throw_dom_exception`'s shape. Returns `None` if
/// `obj` is not an `AbortSignal` instance.
pub(crate) fn abort_reason<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    obj: v8::Local<v8::Object>,
) -> Option<v8::Local<'s, v8::Value>> {
    if !is_signal_instance(scope, obj) {
        return None;
    }
    let state = signal_state(scope, obj);
    if !state.aborted.get() {
        return None;
    }
    let reason = state.reason.borrow();
    match reason.as_ref() {
        Some(g) => Some(v8::Local::new(scope, g)),
        None => Some(make_named_error(scope, "AbortError", "The operation was aborted")),
    }
}

/// Register an `"abort"` listener on `signal` that invokes `cb` (a
/// native `Function` built by the caller) when the signal aborts. Used by
/// `fetch()` to wire cancellation: the trampoline removes the pending
/// task, rejects the promise with the signal's reason, and cancels the
/// tokio task. This is just `addEventListener("abort", cb, {once})`
/// invoked from Rust — shared with the existing `addEventListener`
/// machinery so dispatch, dedup, and `once`-removal all work for free.
pub(crate) fn add_abort_listener(
    scope: &mut v8::PinScope,
    signal: v8::Local<v8::Object>,
    callback: v8::Local<v8::Function>,
) {
    add_listener_internal(scope, signal, "abort", callback, false, true);
}