//! `DOMException` — Web IDL §3.14
//! (https://webidl.spec.whatwg.org/#idl-DOMException).
//!
//! A real constructible class, not the `Error`-with-a-`.name` stand-in the
//! rest of the runtime used to fake. This matters observably: `AbortSignal`'s
//! abort reason, `AbortSignal.timeout()`'s `TimeoutError`, and `atob`'s
//! `InvalidCharacterError` are all specified to be `DOMException`s, and
//! ordinary user code checks them with `e instanceof DOMException` or
//! `e.name === "AbortError"` — the former only works with a real class.
//!
//! Shape (all verified against browsers):
//!   - `new DOMException(message = "", name = "Error")`
//!   - `.name` / `.message` — readonly, per-instance.
//!   - `.code` — readonly; the legacy numeric code for `name` (0 if the name
//!     isn't in the legacy table). Per Web IDL's "legacy code" table.
//!   - `DOMException.prototype.__proto__ === Error.prototype`, so
//!     `e instanceof Error` is `true` (spec: the interface inherits Error).
//!   - The 25 legacy `*_ERR` integer constants exist on both the constructor
//!     and the prototype (`DOMException.INDEX_SIZE_ERR === 1`).
//!   - `.stack` is captured at construction (V8's stack, copied off a
//!     throwaway `Error`) — not spec text, but every engine has it and
//!     debugging without it is miserable.

use crate::web::native;
use std::cell::RefCell;

thread_local! {
    /// Cached constructor so Rust callers (`throw_dom_exception`,
    /// `AbortSignal`) can mint instances without a `globalThis` lookup —
    /// and so a user reassigning `globalThis.DOMException` can't change
    /// what the runtime itself throws.
    static CTOR: RefCell<Option<v8::Global<v8::Function>>> = const { RefCell::new(None) };
}

/// Per-instance state (internal field 0).
struct DomExceptionState {
    name: String,
    message: String,
}

/// Web IDL's legacy code table: error name -> legacy numeric `code`.
/// Names not listed (`AbortError` and every other modern name) map to 0.
const LEGACY_CODES: &[(&str, u16)] = &[
    ("IndexSizeError", 1),
    ("DOMStringSizeError", 2),
    ("HierarchyRequestError", 3),
    ("WrongDocumentError", 4),
    ("InvalidCharacterError", 5),
    ("NoDataAllowedError", 6),
    ("NoModificationAllowedError", 7),
    ("NotFoundError", 8),
    ("NotSupportedError", 9),
    ("InUseAttributeError", 10),
    ("InvalidStateError", 11),
    ("SyntaxError", 12),
    ("InvalidModificationError", 13),
    ("NamespaceError", 14),
    ("InvalidAccessError", 15),
    ("ValidationError", 16),
    ("TypeMismatchError", 17),
    ("SecurityError", 18),
    ("NetworkError", 19),
    ("AbortError", 20),
    ("URLMismatchError", 21),
    ("QuotaExceededError", 22),
    ("TimeoutError", 23),
    ("InvalidNodeTypeError", 24),
    ("DataCloneError", 25),
];

/// The legacy constants, exposed on the constructor and the prototype.
/// (Name, value) — note these use the `_ERR` spelling, unlike `.name`.
const LEGACY_CONSTANTS: &[(&str, u16)] = &[
    ("INDEX_SIZE_ERR", 1),
    ("DOMSTRING_SIZE_ERR", 2),
    ("HIERARCHY_REQUEST_ERR", 3),
    ("WRONG_DOCUMENT_ERR", 4),
    ("INVALID_CHARACTER_ERR", 5),
    ("NO_DATA_ALLOWED_ERR", 6),
    ("NO_MODIFICATION_ALLOWED_ERR", 7),
    ("NOT_FOUND_ERR", 8),
    ("NOT_SUPPORTED_ERR", 9),
    ("INUSE_ATTRIBUTE_ERR", 10),
    ("INVALID_STATE_ERR", 11),
    ("SYNTAX_ERR", 12),
    ("INVALID_MODIFICATION_ERR", 13),
    ("NAMESPACE_ERR", 14),
    ("INVALID_ACCESS_ERR", 15),
    ("VALIDATION_ERR", 16),
    ("TYPE_MISMATCH_ERR", 17),
    ("SECURITY_ERR", 18),
    ("NETWORK_ERR", 19),
    ("ABORT_ERR", 20),
    ("URL_MISMATCH_ERR", 21),
    ("QUOTA_EXCEEDED_ERR", 22),
    ("TIMEOUT_ERR", 23),
    ("INVALID_NODE_TYPE_ERR", 24),
    ("DATA_CLONE_ERR", 25),
];

fn legacy_code(name: &str) -> u16 {
    LEGACY_CODES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, c)| *c)
        .unwrap_or(0)
}

pub fn install(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    let tmpl = v8::FunctionTemplate::new(scope, constructor);
    tmpl.set_class_name(v8::String::new(scope, "DOMException").unwrap());
    tmpl.instance_template(scope).set_internal_field_count(1);

    // Per-instance accessors (holder is the instance, which carries the
    // internal field — same reasoning as `URL`'s accessors).
    let instance = tmpl.instance_template(scope);
    set_readonly_accessor(scope, instance, "name", get_name);
    set_readonly_accessor(scope, instance, "message", get_message);
    set_readonly_accessor(scope, instance, "code", get_code);

    let ctor = tmpl.get_function(scope).unwrap();

    // `DOMException.prototype.__proto__ = Error.prototype` — the spec says
    // the interface inherits from `Error`, which is what makes
    // `domException instanceof Error` true and gives it `Error.prototype`'s
    // `toString`. `FunctionTemplate::inherit` can't express this (there's no
    // `FunctionTemplate` for the intrinsic `Error`), so wire the prototype
    // objects directly.
    let proto_key = v8::String::new(scope, "prototype").unwrap();
    if let Some(proto_val) = ctor.get(scope, proto_key.into()) {
        if let Ok(proto_obj) = <v8::Local<v8::Object>>::try_from(proto_val) {
            let error_key = v8::String::new(scope, "Error").unwrap();
            if let Some(error_ctor) = global.get(scope, error_key.into()) {
                if let Ok(error_ctor) = <v8::Local<v8::Object>>::try_from(error_ctor) {
                    if let Some(error_proto) = error_ctor.get(scope, proto_key.into()) {
                        let _ = proto_obj.set_prototype(scope, error_proto);
                    }
                }
            }
            // Legacy constants live on the prototype as well as the ctor.
            for (name, value) in LEGACY_CONSTANTS {
                set_const(scope, proto_obj, name, *value);
            }
        }
    }
    let ctor_obj: v8::Local<v8::Object> = ctor.into();
    for (name, value) in LEGACY_CONSTANTS {
        set_const(scope, ctor_obj, name, *value);
    }

    CTOR.with(|c| *c.borrow_mut() = Some(v8::Global::new(scope, ctor)));
    crate::web::set_global(scope, global, "DOMException", ctor.into());
}

/// `new DOMException(message = "", name = "Error")`
fn constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    if !args.is_construct_call() {
        crate::web::throw_type_error(
            scope,
            "Failed to construct 'DOMException': Please use the 'new' operator",
        );
        return;
    }
    let message = if args.length() > 0 && !args.get(0).is_undefined() {
        args.get(0).to_rust_string_lossy(scope)
    } else {
        String::new()
    };
    let name = if args.length() > 1 && !args.get(1).is_undefined() {
        args.get(1).to_rust_string_lossy(scope)
    } else {
        "Error".to_string()
    };

    let this = args.this();
    attach_stack(scope, this, &message);
    native::store(scope, this, 0, DomExceptionState { name, message });
    rv.set(this.into());
}

/// Copy a V8-captured `.stack` onto `target`. V8 only fills `stack` in for
/// objects it constructs as errors, so mint a throwaway `Error` purely to
/// harvest its stack string. Best-effort: a missing stack is not fatal.
fn attach_stack(scope: &mut v8::PinScope, target: v8::Local<v8::Object>, message: &str) {
    let msg = v8::String::new(scope, message).unwrap();
    let err = v8::Exception::error(scope, msg);
    let Ok(err_obj) = <v8::Local<v8::Object>>::try_from(err) else {
        return;
    };
    let stack_key = v8::String::new(scope, "stack").unwrap();
    if let Some(stack) = err_obj.get(scope, stack_key.into()) {
        target.set(scope, stack_key.into(), stack);
    }
}

/// Build a `DOMException` from Rust. Used by `throw_dom_exception` and by
/// `AbortSignal` (whose default abort reason is an `AbortError` DOMException).
pub fn new_instance<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    name: &str,
    message: &str,
) -> v8::Local<'s, v8::Value> {
    let ctor = CTOR.with(|c| c.borrow().clone());
    let Some(ctor) = ctor else {
        // Only reachable if something throws before `web::install` ran.
        let msg = v8::String::new(scope, message).unwrap();
        return v8::Exception::error(scope, msg);
    };
    let ctor = v8::Local::new(scope, &ctor);
    let msg = v8::String::new(scope, message).unwrap();
    let nm = v8::String::new(scope, name).unwrap();
    match ctor.new_instance(scope, &[msg.into(), nm.into()]) {
        Some(instance) => instance.into(),
        None => {
            let msg = v8::String::new(scope, message).unwrap();
            v8::Exception::error(scope, msg)
        }
    }
}

fn get_name(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &DomExceptionState = native::get(scope, args.holder(), 0);
    rv.set(v8::String::new(scope, &state.name).unwrap().into());
}

fn get_message(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &DomExceptionState = native::get(scope, args.holder(), 0);
    rv.set(v8::String::new(scope, &state.message).unwrap().into());
}

fn get_code(
    scope: &mut v8::PinScope,
    _key: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let state: &DomExceptionState = native::get(scope, args.holder(), 0);
    rv.set(v8::Number::new(scope, legacy_code(&state.name) as f64).into());
}

/// Install a legacy `*_ERR` constant: readonly + non-configurable per Web IDL.
fn set_const(scope: &mut v8::PinScope, target: v8::Local<v8::Object>, name: &str, value: u16) {
    let key = v8::String::new(scope, name).unwrap();
    let val = v8::Number::new(scope, value as f64);
    target.define_own_property(
        scope,
        key.into(),
        val.into(),
        v8::PropertyAttribute::READ_ONLY | v8::PropertyAttribute::DONT_DELETE,
    );
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
