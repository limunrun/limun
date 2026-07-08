//! `ReadableStream` / `ReadableStreamReader` — WHATWG Streams Standard
//! (https://streams.spec.whatwg.org/).
//!
//! Simplifications vs. spec (documented):
//!   - Default (non-BYOB) mode only — `getReader({ mode: "byob" })` throws.
//!   - `underlyingSource` only supports a `start(controller)` callback with
//!     `enqueue(chunk)`/`close()`/`error(e)` on the controller. No `pull`/
//!     `cancel`/`type`/`strategy`/backpressure/highWaterMark — enough for
//!     `Response.body` (a fully-buffered one-shot stream) and for a basic
//!     user-facing push source. `TextDecoderStream`/`TextEncoderStream` will
//!     build on this in a follow-up.
//!   - Chunks are byte slices (`ArrayBufferView`/`ArrayBuffer`/string on
//!     enqueue; yielded back as `Uint8Array`). The full byte-level
//!     `ReadableStream`/`ReadableByteStreamController` is out of scope.
//!   - `locked` is true once a reader is acquired and not released.
//!   - `cancel(reason)` closes the stream and rejects any pending read.
//!   - `read()` returns a Promise resolving `{done, value}`. If a chunk is
//!     pending it resolves immediately; if closed and empty, resolves
//!     `{done: true, value: undefined}`; otherwise the promise stays
//!     pending until `enqueue`/`close` (a queue of waiting resolvers).
//!   - `reader.closed` returns a Promise that resolves on close, rejects
//!     on error.
//!
//! State is shared between the stream and its reader via an
//! `Rc<RefCell<StreamState>>` stashed in the stream's internal field 0.
//! The reader holds a `Global<Object>` of its stream and looks the state
//! up through it — both are single-threaded on the V8 thread, so `Rc` is
//! fine (no `Send` needed).

use crate::web::native;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

thread_local! {
    /// The reader's `FunctionTemplate`, kept alive so `getReader` can build
    /// reader instances with the correct prototype chain *without* going
    /// through the public constructor (which re-checks `locked` and would
    /// throw — `getReader` owns the lock transition).
    static READER_TEMPLATE: RefCell<Option<v8::Global<v8::FunctionTemplate>>> = const { RefCell::new(None) };
}

/// Shared mutable state between a `ReadableStream` and its active reader.
struct StreamState {
    /// Pending chunks not yet pulled by a reader, in enqueue order.
    chunks: VecDeque<Vec<u8>>,
    /// `true` once `controller.close()` ran (or the stream was constructed
    /// already-closed, as `Response.body` does).
    closed: bool,
    /// `true` while a reader is attached and not released.
    locked: bool,
    /// Pending `read()` resolvers waiting for a chunk or close. FIFO —
    /// `enqueue`/`close` resolves the oldest first.
    waiting: Vec<v8::Global<v8::PromiseResolver>>,
    /// Resolvers for `reader.closed` promises — resolved on close,
    /// rejected on error.
    close_resolvers: Vec<v8::Global<v8::PromiseResolver>>,
    /// Set by `controller.error(e)` / `cancel(reason)` — rejects pending
    /// reads and future `reader.closed`.
    error: Option<v8::Global<v8::Value>>,
}

type Shared = Rc<RefCell<StreamState>>;

/// Box around the shared state, stored in the stream's internal field.
struct StreamBox(Shared);

pub fn install(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    install_readable_stream(scope, global);
    install_reader(scope, global);
}

// --- ReadableStream --------------------------------------------------------

fn install_readable_stream(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    let tmpl = v8::FunctionTemplate::new(scope, stream_constructor);
    tmpl.set_class_name(v8::String::new(scope, "ReadableStream").unwrap());
    let instance = tmpl.instance_template(scope);
    instance.set_internal_field_count(1);

    set_readonly_accessor(scope, instance, "locked", get_locked);

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "cancel", stream_cancel);
    set_method(scope, proto, "getReader", get_reader);
    // Async iteration: `for await (const chunk of stream)`. `values()` and
    // `[Symbol.asyncIterator]` are the same operation (per the Streams
    // Standard's async-iterator declaration).
    set_method(scope, proto, "values", stream_values);
    let async_iter_key = v8::Symbol::get_async_iterator(scope);
    let values_tmpl = v8::FunctionTemplate::new(scope, stream_values);
    proto.set(async_iter_key.into(), values_tmpl.into());

    let ctor = tmpl.get_function(scope).unwrap();
    crate::web::set_global(scope, global, "ReadableStream", ctor.into());
}

fn stream_constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !args.is_construct_call() {
        crate::web::throw_type_error(scope, "Failed to construct 'ReadableStream': Please use the 'new' operator");
        return;
    }

    let this = args.this();
    let shared: Shared = Rc::new(RefCell::new(StreamState {
        chunks: VecDeque::new(),
        closed: false,
        locked: false,
        waiting: Vec::new(),
        close_resolvers: Vec::new(),
        error: None,
    }));
    native::store(scope, this, 0, StreamBox(shared.clone()));

    // Minimal `underlyingSource.start(controller)` support: build a
    // controller object whose `enqueue`/`close`/`error` push into the
    // shared state (stashed in the controller's own internal field so the
    // named callbacks can read it back via `args.this()` — V8 function
    // callbacks must be `Copy`/`UnitType`, so they can't capture `Rc`
    // or `Global` directly).
    if args.length() > 0 && !args.get(0).is_undefined() && !args.get(0).is_null() {
        if let Ok(src) = <v8::Local<v8::Object>>::try_from(args.get(0)) {
            let start_key = v8::String::new(scope, "start").unwrap();
            if let Some(start_val) = src.get(scope, start_key.into()) {
                if let Ok(start_fn) = <v8::Local<v8::Function>>::try_from(start_val) {
                    let controller = make_controller(scope, shared.clone(), this);
                    start_fn.call(scope, this.into(), &[controller.into()]);
                }
            }
        }
    }

    rv.set(this.into());
}

/// Build the `{ enqueue, close, error }` controller object handed to
/// `underlyingSource.start`. The `Shared` state is stashed in the
/// controller's internal field 0 so the named callbacks (which must be
/// `Copy`/`UnitType`) can read it back via `args.this()` instead of
/// capturing it. Built from an `ObjectTemplate` with one internal field
/// (plain `v8::Object::new` has zero, so `set_internal_field` would fail).
fn make_controller<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    shared: Shared,
    _stream: v8::Local<v8::Object>,
) -> v8::Local<'s, v8::Object> {
    let tmpl = v8::ObjectTemplate::new(scope);
    tmpl.set_internal_field_count(1);
    let obj = tmpl.new_instance(scope).unwrap();
    native::store(scope, obj, 0, StreamBox(shared));

    let enqueue_fn = v8::Function::new(scope, controller_enqueue).unwrap();
    let key = v8::String::new(scope, "enqueue").unwrap();
    obj.set(scope, key.into(), enqueue_fn.into());

    let close_fn = v8::Function::new(scope, controller_close).unwrap();
    let key = v8::String::new(scope, "close").unwrap();
    obj.set(scope, key.into(), close_fn.into());

    let error_fn = v8::Function::new(scope, controller_error).unwrap();
    let key = v8::String::new(scope, "error").unwrap();
    obj.set(scope, key.into(), error_fn.into());

    obj
}

fn controller_enqueue(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let shared = stream_state(scope, args.this());
    let bytes = if let Some(b) = native::read_buffer_source(args.get(0)) {
        b
    } else {
        args.get(0).to_rust_string_lossy(scope).into_bytes()
    };
    push_chunk(scope, shared, bytes);
}

fn controller_close(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let shared = stream_state(scope, args.this());
    close_stream(scope, shared);
}

fn controller_error(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let shared = stream_state(scope, args.this());
    let reason = v8::Global::new(scope, args.get(0));
    error_stream(scope, shared, reason);
}

fn get_locked(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let shared = stream_state(scope, args.holder());
    rv.set(v8::Boolean::new(scope, shared.borrow().locked).into());
}

fn stream_cancel(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let shared = stream_state(scope, args.this());
    let reason = if args.length() > 0 && !args.get(0).is_undefined() {
        Some(v8::Global::new(scope, args.get(0)))
    } else {
        None
    };
    cancel_stream(scope, shared, reason);
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    resolver.resolve(scope, v8::undefined(scope).into());
    rv.set(resolver.get_promise(scope).into());
}

fn get_reader(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    // Reject BYOB mode — we only support the default reader.
    if args.length() > 0 && !args.get(0).is_undefined() {
        if let Ok(opts) = <v8::Local<v8::Object>>::try_from(args.get(0)) {
            let mode_key = v8::String::new(scope, "mode").unwrap();
            if let Some(mode) = opts.get(scope, mode_key.into()) {
                if !mode.is_undefined() {
                    let mode_str = mode.to_rust_string_lossy(scope);
                    if mode_str == "byob" {
                        crate::web::throw_type_error(scope, "getReader: BYOB mode is not supported");
                        return;
                    }
                }
            }
        }
    }

    let this = args.this();
    match acquire_reader(scope, this) {
        Some(reader) => rv.set(reader.into()),
        None => {} // acquire_reader already threw (already locked)
    }
}

/// Take the reader lock on `stream` and build a reader instance bound to it,
/// or throw `TypeError` and return `None` if the stream is already locked.
/// Shared by `getReader()` and the async iterator (`values()`).
fn acquire_reader<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    stream: v8::Local<v8::Object>,
) -> Option<v8::Local<'s, v8::Object>> {
    let shared = stream_state(scope, stream);
    if shared.borrow().locked {
        crate::web::throw_type_error(scope, "getReader: ReadableStream is already locked");
        return None;
    }
    shared.borrow_mut().locked = true;
    Some(reader_new_instance(scope, stream))
}

// --- async iteration -------------------------------------------------------

/// Per-async-iterator state: the reader it drives (one reader per iterator,
/// acquired when iteration starts — the stream is locked for its duration).
struct StreamIterState {
    reader: v8::Global<v8::Object>,
}

/// `stream.values()` / `stream[Symbol.asyncIterator]()` — acquire a reader
/// and return an async iterator whose `next()` reads the next chunk and
/// `return()` cancels + releases. If the stream is already locked, throws.
fn stream_values(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let this = args.this();
    let Some(reader) = acquire_reader(scope, this) else {
        return; // already threw
    };

    let tmpl = v8::ObjectTemplate::new(scope);
    tmpl.set_internal_field_count(1);
    let iter = tmpl.new_instance(scope).unwrap();
    native::store(scope, iter, 0, StreamIterState { reader: v8::Global::new(scope, reader) });

    set_own_fn(scope, iter, "next", iter_next);
    set_own_fn(scope, iter, "return", iter_return);
    // `asyncIterator[Symbol.asyncIterator]()` returns itself so the same
    // object works with `for await` directly.
    let self_fn = v8::Function::new(scope, iter_self).unwrap();
    let async_iter_key = v8::Symbol::get_async_iterator(scope);
    iter.set(scope, async_iter_key.into(), self_fn.into());

    rv.set(iter.into());
}

fn iter_next(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let st: &StreamIterState = native::get(scope, args.this(), 0);
    let reader = v8::Local::new(scope, &st.reader);
    // Delegate to `reader.read()` — it already returns a Promise of the
    // `{ value, done }` shape the async-iterator protocol expects.
    let read_key = v8::String::new(scope, "read").unwrap();
    if let Some(read_val) = reader.get(scope, read_key.into()) {
        if let Ok(read_fn) = <v8::Local<v8::Function>>::try_from(read_val) {
            if let Some(promise) = read_fn.call(scope, reader.into(), &[]) {
                rv.set(promise);
                return;
            }
        }
    }
    // Fallback (shouldn't happen): resolved { done: true }.
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    resolve_done(scope, &resolver);
    rv.set(resolver.get_promise(scope).into());
}

fn iter_return(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let value = if args.length() > 0 { args.get(0) } else { v8::undefined(scope).into() };
    let st: &StreamIterState = native::get(scope, args.this(), 0);
    let reader = v8::Local::new(scope, &st.reader);
    // Early exit from `for await` (break/throw): cancel the underlying
    // stream and release the lock, per the async-iterator return steps.
    call_reader_method(scope, reader, "cancel", &[value]);
    call_reader_method(scope, reader, "releaseLock", &[]);
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let obj = v8::Object::new(scope);
    let done_key = v8::String::new(scope, "done").unwrap();
    let value_key = v8::String::new(scope, "value").unwrap();
    obj.set(scope, done_key.into(), v8::Boolean::new(scope, true).into());
    obj.set(scope, value_key.into(), value);
    resolver.resolve(scope, obj.into());
    rv.set(resolver.get_promise(scope).into());
}

fn iter_self(
    _scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    rv.set(args.this().into());
}

/// Invoke a named method on a reader object (best-effort; ignores result).
fn call_reader_method(
    scope: &mut v8::PinScope,
    reader: v8::Local<v8::Object>,
    name: &str,
    argv: &[v8::Local<v8::Value>],
) {
    let key = v8::String::new(scope, name).unwrap();
    if let Some(val) = reader.get(scope, key.into()) {
        if let Ok(func) = <v8::Local<v8::Function>>::try_from(val) {
            func.call(scope, reader.into(), argv);
        }
    }
}

fn set_own_fn(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::Object>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    let func = v8::Function::new(scope, callback).unwrap();
    target.set(scope, key.into(), func.into());
}

// --- ReadableStreamReader --------------------------------------------------

fn install_reader(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    let tmpl = v8::FunctionTemplate::new(scope, reader_constructor);
    tmpl.set_class_name(v8::String::new(scope, "ReadableStreamReader").unwrap());
    let instance = tmpl.instance_template(scope);
    instance.set_internal_field_count(1);

    set_readonly_accessor(scope, instance, "closed", reader_get_closed);

    let proto = tmpl.prototype_template(scope);
    set_method(scope, proto, "read", reader_read);
    set_method(scope, proto, "cancel", reader_cancel);
    set_method(scope, proto, "releaseLock", reader_release_lock);

    let ctor = tmpl.get_function(scope).unwrap();
    // `ReadableStreamReader` is exposed by `getReader()`, not a public
    // constructor, but install it on globalThis for `instanceof` parity.
    crate::web::set_global(scope, global, "ReadableStreamReader", ctor.into());
    // Keep the template alive so `getReader` can build instances with the
    // correct prototype without invoking the public constructor (which
    // would re-check `locked` and throw — `getReader` owns the transition).
    READER_TEMPLATE.with(|r| *r.borrow_mut() = Some(v8::Global::new(scope, tmpl)));
}

/// Internal state of a reader — just the stream it's bound to.
struct ReaderState {
    stream: v8::Global<v8::Object>,
}

fn reader_constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    // Direct construction isn't in the spec surface (you get a reader via
    // `getReader()`), but allow it for parity: `new ReadableStreamReader(stream)`.
    if !args.is_construct_call() {
        crate::web::throw_type_error(scope, "Failed to construct 'ReadableStreamReader': Please use the 'new' operator");
        return;
    }
    let Ok(stream) = <v8::Local<v8::Object>>::try_from(args.get(0)) else {
        crate::web::throw_type_error(scope, "ReadableStreamReader: argument must be a ReadableStream");
        return;
    };
    let shared = stream_state(scope, stream);
    if shared.borrow().locked {
        crate::web::throw_type_error(scope, "ReadableStreamReader: ReadableStream is already locked");
        return;
    }
    shared.borrow_mut().locked = true;
    let this = args.this();
    native::store(
        scope,
        this,
        0,
        ReaderState { stream: v8::Global::new(scope, stream) },
    );
    rv.set(this.into());
}

/// Build a reader instance bound to `stream` (called from `getReader`).
/// Uses the cached reader `FunctionTemplate` directly — building via the
/// public `ReadableStreamReader` constructor would re-check `locked` and
/// throw (the lock was already taken by `getReader`), so we bypass it.
fn reader_new_instance<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    stream: v8::Local<v8::Object>,
) -> v8::Local<'s, v8::Object> {
    let instance = READER_TEMPLATE.with(|r| {
        let global = r.borrow().as_ref().unwrap().clone();
        let tmpl = v8::Local::new(scope, &global);
        tmpl.instance_template(scope).new_instance(scope).unwrap()
    });
    native::store(
        scope,
        instance,
        0,
        ReaderState { stream: v8::Global::new(scope, stream) },
    );
    instance
}

fn reader_state<'a>(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>) -> &'a ReaderState {
    native::get(scope, obj, 0)
}

fn reader_get_closed(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let rs = reader_state(scope, args.holder());
    let stream = v8::Local::new(scope, &rs.stream);
    let shared = stream_state(scope, stream);
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    let s = shared.borrow();
    if let Some(err) = &s.error {
        let err_local = v8::Local::new(scope, err);
        resolver.reject(scope, err_local);
    } else if s.closed {
        resolver.resolve(scope, v8::undefined(scope).into());
    } else {
        drop(s);
        shared.borrow_mut().close_resolvers.push(v8::Global::new(scope, resolver));
    }
    rv.set(promise.into());
}

fn reader_read(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let rs = reader_state(scope, args.this());
    let stream = v8::Local::new(scope, &rs.stream);
    let shared = stream_state(scope, stream);

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    let mut s = shared.borrow_mut();
    // If errored, reject immediately.
    if let Some(err) = &s.error {
        let err_local = v8::Local::new(scope, err);
        drop(s);
        resolver.reject(scope, err_local);
        return;
    }
    if let Some(bytes) = s.chunks.pop_front() {
        drop(s);
        resolve_chunk(scope, &resolver, bytes);
        return;
    }
    if s.closed {
        drop(s);
        resolve_done(scope, &resolver);
        return;
    }
    // No chunk yet, not closed: park the resolver.
    s.waiting.push(v8::Global::new(scope, resolver));
}

fn reader_cancel(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let rs = reader_state(scope, args.this());
    let stream = v8::Local::new(scope, &rs.stream);
    let shared = stream_state(scope, stream);
    let reason = if args.length() > 0 && !args.get(0).is_undefined() {
        Some(v8::Global::new(scope, args.get(0)))
    } else {
        None
    };
    cancel_stream(scope, shared, reason);
    // Release the lock as part of cancel (spec: cancel releases the reader).
    release_lock(scope, args.this());
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    resolver.resolve(scope, v8::undefined(scope).into());
    rv.set(resolver.get_promise(scope).into());
}

fn reader_release_lock(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    release_lock(scope, args.this());
}

// --- shared state helpers --------------------------------------------------

fn stream_state<'a>(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>) -> &'a Shared {
    // `native::get` returns a borrow with an unbounded lifetime (it does
    // its own unsafe pointer deref internally), so this just unwraps the
    // `StreamBox` to expose the inner `Rc`.
    let box_ref: &'a StreamBox = native::get(scope, obj, 0);
    &box_ref.0
}

fn push_chunk(scope: &mut v8::PinScope, shared: &Shared, bytes: Vec<u8>) {
    let mut s = shared.borrow_mut();
    if s.closed || s.error.is_some() {
        return; // spec: enqueue after close/error is a no-op (we don't throw)
    }
    // If a reader is waiting, resolve the *oldest* one directly (FIFO)
    // instead of queueing the chunk.
    if !s.waiting.is_empty() {
        let resolver_global = s.waiting.remove(0);
        drop(s);
        let resolver = v8::Local::new(scope, &resolver_global);
        resolve_chunk(scope, &resolver, bytes);
        return;
    }
    s.chunks.push_back(bytes);
}

fn close_stream(scope: &mut v8::PinScope, shared: &Shared) {
    let mut s = shared.borrow_mut();
    if s.closed || s.error.is_some() {
        return;
    }
    s.closed = true;
    // Resolve any waiting reads with {done: true} — there are no more
    // chunks coming.
    let waiters: Vec<_> = s.waiting.drain(..).collect();
    let closers: Vec<_> = s.close_resolvers.drain(..).collect();
    drop(s);
    for resolver_global in waiters {
        let resolver = v8::Local::new(scope, &resolver_global);
        resolve_done(scope, &resolver);
    }
    for resolver_global in closers {
        let resolver = v8::Local::new(scope, &resolver_global);
        resolver.resolve(scope, v8::undefined(scope).into());
    }
}

fn error_stream(
    scope: &mut v8::PinScope,
    shared: &Shared,
    reason: v8::Global<v8::Value>,
) {
    let mut s = shared.borrow_mut();
    if s.closed || s.error.is_some() {
        return;
    }
    s.error = Some(reason);
    let waiters: Vec<_> = s.waiting.drain(..).collect();
    let closers: Vec<_> = s.close_resolvers.drain(..).collect();
    let err_local = s.error.as_ref().map(|g| v8::Local::new(scope, g));
    drop(s);
    for resolver_global in waiters {
        let resolver = v8::Local::new(scope, &resolver_global);
        if let Some(err) = err_local {
            resolver.reject(scope, err);
        }
    }
    for resolver_global in closers {
        let resolver = v8::Local::new(scope, &resolver_global);
        if let Some(err) = err_local {
            resolver.reject(scope, err);
        }
    }
}

fn cancel_stream(
    scope: &mut v8::PinScope,
    shared: &Shared,
    reason: Option<v8::Global<v8::Value>>,
) {
    // Cancel = error the stream with `reason` (or undefined), which
    // rejects pending reads and future `reader.closed`.
    let reason = reason.unwrap_or_else(|| {
        let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
        v8::Global::new(scope, undef)
    });
    error_stream(scope, shared, reason);
}

fn release_lock(scope: &mut v8::PinScope, reader: v8::Local<v8::Object>) {
    let rs = reader_state(scope, reader);
    let stream = v8::Local::new(scope, &rs.stream);
    let shared = stream_state(scope, stream);
    // Reject any pending reads from this reader with a TypeError, then
    // mark unlocked.
    let waiters: Vec<_> = shared.borrow_mut().waiting.drain(..).collect();
    let msg = v8::String::new(scope, "releaseLock: pending read was released").unwrap();
    let exc = v8::Exception::type_error(scope, msg);
    for resolver_global in waiters {
        let resolver = v8::Local::new(scope, &resolver_global);
        resolver.reject(scope, exc);
    }
    shared.borrow_mut().locked = false;
}

// --- promise settlement helpers --------------------------------------------

fn resolve_chunk(scope: &mut v8::PinScope, resolver: &v8::Local<v8::PromiseResolver>, bytes: Vec<u8>) {
    let len = bytes.len();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    let ab = v8::ArrayBuffer::with_backing_store(scope, &store);
    let view = v8::Uint8Array::new(scope, ab, 0, len).unwrap();
    let obj = v8::Object::new(scope);
    let done_key = v8::String::new(scope, "done").unwrap();
    let value_key = v8::String::new(scope, "value").unwrap();
    obj.set(scope, done_key.into(), v8::Boolean::new(scope, false).into());
    obj.set(scope, value_key.into(), view.into());
    resolver.resolve(scope, obj.into());
}

fn resolve_done(scope: &mut v8::PinScope, resolver: &v8::Local<v8::PromiseResolver>) {
    let obj = v8::Object::new(scope);
    let done_key = v8::String::new(scope, "done").unwrap();
    let value_key = v8::String::new(scope, "value").unwrap();
    obj.set(scope, done_key.into(), v8::Boolean::new(scope, true).into());
    obj.set(scope, value_key.into(), v8::undefined(scope).into());
    resolver.resolve(scope, obj.into());
}

// --- construction from Rust (for Response.body) ----------------------------

/// Build a `ReadableStream` instance whose chunks are pre-populated and
/// which is already closed (the body is fully buffered). Used by
/// `Response.body` — yields each chunk in order, then `{done: true}`.
pub(crate) fn new_fixed_stream<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    chunks: Vec<Vec<u8>>,
) -> v8::Local<'s, v8::Object> {
    let global = scope.get_current_context().global(scope);
    let key = v8::String::new(scope, "ReadableStream").unwrap();
    let ctor: v8::Local<v8::Function> = global.get(scope, key.into()).unwrap().try_into().unwrap();
    let instance = ctor.new_instance(scope, &[]).unwrap();
    // Drop empty chunks: an empty body must read as `{done: true}` straight
    // away, not deliver a zero-length `Uint8Array` first (matches browsers).
    let chunks: VecDeque<Vec<u8>> = chunks.into_iter().filter(|c| !c.is_empty()).collect();
    // Overwrite the constructor's empty state with our pre-filled one.
    let shared: Shared = Rc::new(RefCell::new(StreamState {
        chunks,
        closed: true,
        locked: false,
        waiting: Vec::new(),
        close_resolvers: Vec::new(),
        error: None,
    }));
    native::store(scope, instance, 0, StreamBox(shared));
    instance
}

// --- template helpers (same shape as url.rs / response.rs) -----------------

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

fn set_readonly_accessor(
    scope: &mut v8::PinScope,
    target: v8::Local<v8::ObjectTemplate>,
    name: &str,
    getter: impl v8::MapFnTo<v8::AccessorNameGetterCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    target.set_accessor(key.into(), getter);
}