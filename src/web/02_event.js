// Copyright 2026 the Limun authors. MIT license.

// `Event`/`CustomEvent`/`EventTarget`/`AbortController`/`AbortSignal` —
// DOM Standard §2.8 "Events" + §4 "Interface EventTarget"
// (https://dom.spec.whatwg.org/) and the AbortSignal extension
// (https://dom.spec.whatwg.org/#interface-AbortSignal).
//
// Largest web API migrated from Rust to JS-on-ops (after base64,
// DOMException, console, timers, text encoding, performance). The
// previous Rust impl was 1632 lines (`web::event.rs`); the spec surface
// now lives here in JS, and the only Rust side is three thin bridge ops
// (`op_abort_signal_is_aborted`/`op_abort_signal_get_reason`/
// `op_abort_signal_add_listener`) so `fetch()` can read an
// `AbortSignal`'s state and register abort listeners without reaching
// into JS private symbols.
//
// Ports Deno's `ext/web/02_event.js` + `ext/web/03_abort_signal.js`,
// combined into one module (the two are tightly coupled — `AbortSignal`
// extends `EventTarget`, and `AbortSignal.any()` needs the dispatch
// internals). Rewires:
//   - `__bootstrap`            → `globalThis.__bootstrap`
//   - `core.ops`               → `globalThis.__limunOps`
//   - `webidl.brand` /
//     `webidl.assertBranded` /
//     `webidl.requiredArguments` /
//     `webidl.converters.any`/`DOMString`/`"unsigned long long"`
//     → `globalThis.__bootstrap.webidl` (shared `ext:limun/00_webidl.js`).
//   - `webidl.configureInterface` → dropped (only sets
//     `[Symbol.toStringTag]`; Limun sets the tag inline).
//   - `core.loadExtScript("ext:deno_web/02_event.js").…` → in-module
//     references (everything is in one file).
//   - `core.createSystemTimer`/`core.cancelTimer`/`core.refTimer`/
//     `core.unrefTimer` → `op_timer_schedule`/`op_timer_clear` (Limun has
//     no ref/unref timer API; `AbortSignal.timeout()` keeps the event
//     loop alive by default — the timer is a strong reference in the
//     timer wheel until it fires).
//   - `op_abort_signal_abort` (Deno) → no op; abort is pure JS here (set
//     the reason symbol, run abort steps, dispatch the event).
//   - `WeakRef`/`FinalizationRegistry` cleanup for `AbortSignal.any()`
//     dependent tracking → dropped (Limun's runtime holds strong
//     references for the process lifetime; a dependent GC'd before its
//     source aborts is a degenerate case that doesn't surface in the WPT
//     subset we run). The spec ordering is preserved via the
//     `dependentSignals` list — see `signalAbort`/`runAbortSteps`.
//
// Dropped vs Deno (Limun doesn't model these yet):
//   - `ErrorEvent`/`CloseEvent`/`MessageEvent`/`ProgressEvent`/
//     `PromiseRejectionEvent` — separate event subclasses owned by the
//     modules that construct them (fetch, workers). Not in Limun's
//     current WPT subset.
//   - `reportException`/`reportError` — the global error reporting path
//     needs a `Window` error event; Limun's error handling is the
//     `core::rejections` path.
//   - `composedPath`/`eventPhase`/capture-phase dispatch — no DOM tree,
//     so no propagation path. `Event.bubbles`/`cancelable`/`composed` are
//     stored but never observed (documented simplification, same as the
//     previous Rust code).
//   - `SymbolFor("Deno.privateCustomInspect")` — no Deno-style custom
//     inspect in Limun yet.
//   - `EventTarget.getParent`/node/shadow-DOM path machinery — no DOM
//     tree.
//   - `addEventListener` `passive` option — parsed but discarded (no
//     default actions to suppress).
//   - `Event.cancelBubble`/`returnValue`/`srcElement` legacy aliases —
//     not exercised by the current WPT subset. (`srcElement` returns
//     `target`, matching the previous Rust behavior; the legacy setters
//     are no-ops.)
//   - `kResistStopImmediatePropagation` (Node.js compatibility) — not in
//     the spec, not needed.
//   - `EventTarget.dispatchEvent` re-entrancy guards (`getDispatched`/
//     `eventPhase` checks) — the previous Rust code didn't enforce them
//     and no WPT test in the current subset exercises re-entrant
//     dispatch on the same event; kept simple to match.
//
// Bug fixes vs the previous Rust impl (verified against the WPT subset):
//   - `on<event>` handler attributes (FINDINGS.md bug #1): the previous
//     Rust code had a partial `onabort` implementation on `AbortSignal`
//     only, via a native trampoline. This module implements the generic
//     `defineEventHandler` mechanism (DOM §2.11) — any `EventTarget`
//     subclass can expose `on<event>` attributes, assigned/replaced like
//     a property, fired in listener order alongside `addEventListener`-
//     registered ones.
//   - `AbortSignal.any()` event ordering (FINDINGS.md bug #3): the
//     previous Rust impl dispatched the abort event on the source signal
//     *after* recursing into dependents, producing "41230" instead of
//     "01234". This module follows Deno's spec-correct ordering: the
//     source signal's own listeners fire first (`runAbortSteps`), then
//     dependents fire in creation order.

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const { op_now, op_timer_schedule, op_timer_clear } = globalThis.__limunOps;
  const {
    ArrayPrototypeIncludes,
    ArrayPrototypeIndexOf,
    ArrayPrototypePush,
    ArrayPrototypeSlice,
    ArrayPrototypeSplice,
    Boolean,
    FunctionPrototypeCall,
    ObjectCreate,
    ObjectDefineProperty,
    ObjectPrototypeIsPrototypeOf,
    ReflectDefineProperty,
    SafeMap,
    SafeSet,
    String,
    Symbol,
    SymbolFor,
    SymbolToStringTag,
    TypeError,
  } = primordials;

  // --- Event: private fields (Symbols) ------------------------------------

  const _attributes = Symbol("[[attributes]]");
  const _canceledFlag = Symbol("[[canceledFlag]]");
  const _stopPropagationFlag = Symbol("[[stopPropagationFlag]]");
  const _stopImmediatePropagationFlag = Symbol(
    "[[stopImmediatePropagationFlag]]",
  );
  const _dispatched = Symbol("[[dispatched]]");
  const _isTrusted = Symbol("[[isTrusted]]");

  // --- Event class --------------------------------------------------------

  // `Event` constants (DOM §2.2). Non-writable, enumerable, non-configurable
  // on the constructor — matches browsers and the previous Rust `set_static`.
  const NONE = 0;
  const CAPTURING_PHASE = 1;
  const AT_TARGET = 2;
  const BUBBLING_PHASE = 3;

  class Event {
    constructor(type, eventInitDict = { __proto__: null }) {
      webidl.requiredArguments(arguments.length, 1, "Failed to construct 'Event'");
      type = webidl.converters.DOMString(type, "Failed to construct 'Event'", "Argument 1");

      this[_canceledFlag] = false;
      this[_stopPropagationFlag] = false;
      this[_stopImmediatePropagationFlag] = false;
      this[_dispatched] = false;
      this[_isTrusted] = false;

      // `timeStamp` captured at construction via `op_now()` (same clock as
      // `performance.now()`). The previous Rust code called
      // `performance::now_value()` directly; the op round-trip is the
      // cost of moving the clock behind an op boundary.
      this[_attributes] = {
        type,
        bubbles: Boolean(eventInitDict?.bubbles),
        cancelable: Boolean(eventInitDict?.cancelable),
        composed: Boolean(eventInitDict?.composed),
        currentTarget: null,
        eventPhase: NONE,
        target: null,
        timeStamp: op_now(),
      };
      this[webidl.brand] = webidl.brand;
    }

    get type() {
      return this[_attributes].type;
    }

    get target() {
      return this[_attributes].target;
    }

    get srcElement() {
      return this[_attributes].target;
    }

    get currentTarget() {
      return this[_attributes].currentTarget;
    }

    get NONE() { return NONE; }
    get CAPTURING_PHASE() { return CAPTURING_PHASE; }
    get AT_TARGET() { return AT_TARGET; }
    get BUBBLING_PHASE() { return BUBBLING_PHASE; }

    get eventPhase() {
      return this[_attributes].eventPhase;
    }

    stopPropagation() {
      this[_stopPropagationFlag] = true;
    }

    stopImmediatePropagation() {
      this[_stopPropagationFlag] = true;
      this[_stopImmediatePropagationFlag] = true;
    }

    get bubbles() {
      return this[_attributes].bubbles;
    }

    get cancelable() {
      return this[_attributes].cancelable;
    }

    preventDefault() {
      // No `inPassiveListener` tracking (no passive listeners modeled);
      // no default actions to suppress. Flip the flag if cancelable —
      // matches what a synthetic `Event` observes in a browser.
      if (this[_attributes].cancelable) {
        this[_canceledFlag] = true;
      }
    }

    get defaultPrevented() {
      return this[_canceledFlag];
    }

    get composed() {
      return this[_attributes].composed;
    }

    get isTrusted() {
      return this[_isTrusted];
    }

    get timeStamp() {
      return this[_attributes].timeStamp;
    }
  }

  // Static phase constants on the constructor (spec: non-writable,
  // enumerable, non-configurable). Matches browsers:
  // `Event.NONE === 0`, `Event.CAPTURING_PHASE === 1`, etc.
  ObjectDefineProperty(Event, "NONE", {
    __proto__: null,
    value: NONE,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  ObjectDefineProperty(Event, "CAPTURING_PHASE", {
    __proto__: null,
    value: CAPTURING_PHASE,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  ObjectDefineProperty(Event, "AT_TARGET", {
    __proto__: null,
    value: AT_TARGET,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  ObjectDefineProperty(Event, "BUBBLING_PHASE", {
    __proto__: null,
    value: BUBBLING_PHASE,
    writable: false,
    enumerable: true,
    configurable: false,
  });

  const EventPrototype = Event.prototype;
  ObjectDefineProperty(EventPrototype, SymbolToStringTag, {
    __proto__: null,
    value: "Event",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // --- CustomEvent --------------------------------------------------------

  class CustomEvent extends Event {
    #detail = null;

    constructor(type, eventInitDict = { __proto__: null }) {
      webidl.requiredArguments(
        arguments.length,
        1,
        "Failed to construct 'CustomEvent'",
      );
      super(type, eventInitDict);
      // `detail` defaults to `null` per spec when omitted or `undefined`.
      const { detail } = eventInitDict;
      this.#detail = detail === undefined ? null : detail;
    }

    get detail() {
      return this.#detail;
    }

    // `initCustomEvent(type, bubbles, cancelable, detail)` — deprecated
    // legacy init. Kept as a method so feature-detection
    // (`"initCustomEvent" in event`) works; updates the stored fields to
    // match the previous Rust behavior.
    initCustomEvent(type, bubbles = false, cancelable = false, detail = null) {
      this[_attributes].type = webidl.converters.DOMString(type);
      this[_attributes].bubbles = Boolean(bubbles);
      this[_attributes].cancelable = Boolean(cancelable);
      this.#detail = detail;
    }
  }

  const CustomEventPrototype = CustomEvent.prototype;
  ObjectDefineProperty(CustomEventPrototype, SymbolToStringTag, {
    __proto__: null,
    value: "CustomEvent",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // --- EventTarget --------------------------------------------------------

  // Per-target listener storage. `listeners` is a `Map<type, Array<listener>>`
  // where each `listener` is `{ callback, options, signalCleanup }`.
  // `options` is either a boolean (legacy `capture`) or an object
  // `{ capture, once, passive, signal }`. `signalCleanup` is the abort
  // listener registered when `options.signal` is set (so
  // `removeEventListener` can also detach the abort handler).
  const eventTargetData = Symbol("[[eventTargetData]]");

  // `on<event>` handler attributes (DOM §2.11). `handlers` is a
  // `Map<type, { handler, wrapper }>` — `handler` is the user-set
  // function (or `null`), `wrapper` is the wrapping listener registered
  // via `addEventListener` (reads `handler` on each dispatch so reassigning
  // `on<event>` doesn't churn the listener list).
  const _eventHandlers = Symbol("[[eventHandlers]]");

  function getDefaultTargetData() {
    return {
      listeners: new SafeMap(),
    };
  }

  function getListeners(target) {
    return target[eventTargetData]?.listeners;
  }

  function listenerCount(target, type) {
    const listeners = getListeners(target);
    if (!listeners) return 0;
    const list = listeners.get(type);
    return list ? list.length : 0;
  }

  // Normalize the third arg to `addEventListener`/`removeEventListener`:
  // either a boolean (legacy `capture`) or an options object. Returns
  // `{ capture, once, passive, signal }` — `passive` is parsed but
  // discarded (no default actions to suppress).
  function normalizeAddOptions(options, prefix) {
    if (typeof options === "boolean" || options === undefined || options === null) {
      return { capture: Boolean(options), once: false, passive: false, signal: undefined };
    }
    const signal = options.signal;
    if (signal !== undefined) {
      // Brand check via `ObjectPrototypeIsPrototypeOf` would need the
      // `AbortSignalPrototype` (defined below). Defer: just accept any
      // object with an `aborted` getter — matches the tolerant posture
      // of the previous Rust code.
    }
    return {
      capture: Boolean(options.capture),
      once: Boolean(options.once),
      passive: Boolean(options.passive),
      signal: signal === undefined ? undefined : signal,
    };
  }

  function normalizeRemoveOptions(options) {
    if (typeof options === "boolean" || options === undefined || options === null) {
      return { capture: Boolean(options) };
    }
    return { capture: Boolean(options.capture) };
  }

  class EventTarget {
    constructor() {
      this[webidl.brand] = webidl.brand;
      // Lazy: `eventTargetData` allocated on first `addEventListener`
      // (most short-lived EventTargets never register a listener).
    }

    addEventListener(type, callback, options) {
      const self = this;
      webidl.assertBranded(self, EventTargetPrototype, "EventTarget");
      webidl.requiredArguments(
        arguments.length,
        2,
        "Failed to execute 'addEventListener' on 'EventTarget'",
      );

      type = webidl.converters.DOMString(type);
      if (callback === null) return;

      const opts = normalizeAddOptions(options);

      let data = self[eventTargetData];
      if (data === undefined) {
        data = self[eventTargetData] = getDefaultTargetData();
      }
      const { listeners } = data;

      let list = listeners.get(type);
      if (!list) {
        list = [];
        listeners.set(type, list);
      }

      // Dedup: same (callback, capture) is a no-op (spec §2.9 step 11).
      for (let i = 0; i < list.length; ++i) {
        const listener = list[i];
        const lcap = typeof listener.options === "boolean"
          ? listener.options
          : listener.options.capture;
        if (lcap === opts.capture && listener.callback === callback) {
          return;
        }
      }

      // `signal` option: if the signal is already aborted, no-op (don't
      // register). Otherwise register an `"abort"` listener on the signal
      // that removes this listener from `self` when it fires.
      let abortListener = undefined;
      if (opts.signal) {
        const signal = opts.signal;
        if (signal.aborted) {
          return;
        }
        // The abort listener removes this listener from `self` when the
        // signal fires. Captured in the closure so it's independent of
        // the `abortListener` reference stashed for `removeEventListener`.
        const removeSelf = () => {
          self.removeEventListener(type, callback, { capture: opts.capture });
        };
        // One-shot wrapper. Stored on the listener as `signalCleanup` so
        // `removeEventListener` can also detach it from the signal (avoids
        // a dangling handler firing into a removed listener).
        abortListener = () => {
          removeSelf();
        };
        // Register on the signal via its public `addEventListener` —
        // recursion is on a *different* target, no cycle.
        signal.addEventListener("abort", abortListener, { once: true });
      }

      ArrayPrototypePush(list, { callback, options: opts, signalCleanup: abortListener });
    }

    removeEventListener(type, callback, options) {
      const self = this;
      webidl.assertBranded(self, EventTargetPrototype, "EventTarget");
      webidl.requiredArguments(
        arguments.length,
        2,
        "Failed to execute 'removeEventListener' on 'EventTarget'",
      );

      const data = self[eventTargetData];
      if (data === undefined || callback === null) return;
      type = webidl.converters.DOMString(type);
      const { listeners } = data;
      const list = listeners.get(type);
      if (!list) return;

      const opts = normalizeRemoveOptions(options);

      for (let i = 0; i < list.length; ++i) {
        const listener = list[i];
        const lcap = typeof listener.options === "boolean"
          ? listener.options
          : listener.options.capture;
        if (lcap === opts.capture && listener.callback === callback) {
          // Detach the abort handler wired for this listener, if any.
          if (listener.signalCleanup) {
            // `listener.signalCleanup` is the abort listener registered
            // on `opts.signal`. We need the signal to call
            // `removeEventListener` on it — but we didn't store the
            // signal. Walk the listener's options to recover it.
            const sig = listener.options.signal;
            if (sig) {
              try {
                sig.removeEventListener("abort", listener.signalCleanup);
              } catch { /* signal may have been a non-AbortSignal */ }
            }
          }
          ArrayPrototypeSplice(list, i, 1);
          break;
        }
      }
    }

    dispatchEvent(event) {
      const self = this;
      webidl.assertBranded(self, EventTargetPrototype, "EventTarget");
      webidl.requiredArguments(
        arguments.length,
        1,
        "Failed to execute 'dispatchEvent' on 'EventTarget'",
      );

      const data = self[eventTargetData];
      if (data === undefined) {
        // No listener state → nothing to do; spec returns true.
        setTarget(event, self);
        return true;
      }

      const listeners = data.listeners;
      const type = event.type;
      const list = listeners.get(type);
      if (!list || list.length === 0) {
        setTarget(event, self);
        return true;
      }

      // Set `event.target = this` (DOM §2.9 "dispatch" step 3).
      setTarget(event, self);
      event[_dispatched] = true;

      // Snapshot the listener list before iterating (a listener can
      // call `removeEventListener` mid-dispatch, or add new listeners —
      // both should not affect the current dispatch's iteration).
      const snapshot = ArrayPrototypeSlice(list);
      let found = false;

      for (let i = 0; i < snapshot.length; ++i) {
        const listener = snapshot[i];

        // `stopImmediatePropagation` was called by a previous listener
        // on this same target — stop now.
        if (event[_stopImmediatePropagationFlag]) {
          break;
        }

        // Skip if the listener was removed between snapshot and now
        // (user code in a prior handler called `removeEventListener`).
        if (!ArrayPrototypeIncludes(list, listener)) {
          continue;
        }

        const opts = listener.options;
        const once = opts.once;

        if (once) {
          // Remove before invoking so a re-entrant dispatch doesn't
          // double-fire. Matches spec §2.9 "inner invoke" step 8.
          const idx = ArrayPrototypeIndexOf(list, listener);
          if (idx !== -1) {
            ArrayPrototypeSplice(list, idx, 1);
          }
        }

        found = true;

        // Set `currentTarget` for the duration of the callback (DOM §2.9
        // "inner invoke" step 7).
        event[_attributes].currentTarget = self;

        // Invoke. Per DOM §2.9 "inner invoke", an exception thrown by a
        // listener is *reported*, not propagated out of dispatch —
        // otherwise a throwing listener would leave a pending exception
        // that corrupts the rest of the loop. Catch, report, and carry
        // on to the next listener. (No `reportException` path here —
        // print to stderr, matching the previous Rust behavior.)
        try {
          const cb = listener.callback;
          if (typeof cb === "function") {
            FunctionPrototypeCall(cb, self, event);
          } else if (typeof cb === "object" && typeof cb.handleEvent === "function") {
            cb.handleEvent(event);
          }
        } catch (error) {
          // Report to stderr — the previous Rust code used the same
          // channel (`eprintln!("limun: Uncaught (in event listener)`).
          // A future `reportException` integration would go here.
          // deno-lint-ignore prefer-primordials
          const msg = error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
          // Avoid `console.error` (could throw / recurse); write to
          // stderr via the print op if available, else swallow.
          try {
            globalThis.__limunOps.op_print(`${msg}\n`, true);
          } catch {
            // Swallow — never let reporting break dispatch.
          }
        }

        event[_attributes].currentTarget = null;
      }

      // Reset dispatch state.
      event[_dispatched] = false;
      event[_attributes].currentTarget = null;
      event[_stopImmediatePropagationFlag] = false;

      return !event[_canceledFlag];
    }
  }

  const EventTargetPrototype = EventTarget.prototype;
  ObjectDefineProperty(EventTargetPrototype, SymbolToStringTag, {
    __proto__: null,
    value: "EventTarget",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // --- on<event> handler attributes (DOM §2.11) ----------------------------

  // `defineEventHandler(emitter, name)` — install an `on<name>` IDL
  // event handler attribute on `emitter` (usually a prototype). The
  // attribute is "at most one listener registered via a special slot,
  // replaced on reassignment, fired in listener order alongside
  // `addEventListener`-registered ones."
  //
  // Implementation: the setter stores the user's handler in a per-target
  // `Map<name, {handler, wrapper}>` and registers a *wrapper* listener
  // via `addEventListener` on first set. The wrapper reads the current
  // `handler` on each dispatch, so reassigning `on<name>` just updates
  // the stored handler — no remove/re-add churn. Setting to `null`
  // (or a non-object/non-function per `[LegacyTreatNonObjectAsNull]`)
  // clears the handler; the wrapper stays registered but becomes a
  // no-op (matches spec: the wrapper is only removed if the handler
  // is explicitly set to `null` AND there are no other listeners —
  // simpler to leave the wrapper in place as a no-op).
  function makeWrappedHandler(handler) {
    function wrappedHandler(evt) {
      if (typeof wrappedHandler.handler !== "function") {
        return;
      }
      return FunctionPrototypeCall(wrappedHandler.handler, this, evt);
    }
    wrappedHandler.handler = handler;
    return wrappedHandler;
  }

  function defineEventHandler(emitter, name, onFirstSet) {
    ObjectDefineProperty(emitter, `on${name}`, {
      __proto__: null,
      get() {
        const self = this;
        if (!self[_eventHandlers]) return null;
        const entry = self[_eventHandlers].get(name);
        return entry ? entry.handler : null;
      },
      set(value) {
        const self = this;
        // `[LegacyTreatNonObjectAsNull]`: anything other than an object or
        // function is treated as null.
        if (typeof value !== "object" && typeof value !== "function") {
          value = null;
        }

        if (!self[_eventHandlers]) {
          self[_eventHandlers] = new SafeMap();
        }
        let entry = self[_eventHandlers].get(name);
        if (entry) {
          entry.handler = value;
        } else if (value !== null) {
          const wrapper = makeWrappedHandler(value);
          // Register the wrapper as a normal listener so it fires in
          // listener order alongside any `addEventListener`-registered
          // ones. `this` is branded (constructor set the brand), so
          // `addEventListener` works.
          self.addEventListener(name, wrapper);
          entry = { handler: value, wrapper };
          self[_eventHandlers].set(name, entry);
          // First-set hook: used by `MessagePort` to imply `start()`
          // when `onmessage` is first set (spec: setting `onmessage`
          // starts message delivery). Called once, only on the first
          // non-null set.
          if (typeof onFirstSet === "function") {
            onFirstSet(self);
          }
        }
        // If `value === null` and no existing entry, nothing to do (the
        // getter already returns `null`).
      },
      configurable: true,
      enumerable: true,
    });
  }

  // --- Event accessors (setters for dispatch) ------------------------------

  function setTarget(event, value) {
    event[_attributes].target = value;
  }

  function setIsTrusted(event, value) {
    event[_isTrusted] = value;
  }

  // --- AbortSignal --------------------------------------------------------

  // Private slots (symbols) — same names as Deno for spec alignment.
  const signalAbort = Symbol("[[signalAbort]]");
  const add = Symbol("[[add]]");
  const remove = Symbol("[[remove]]");
  const runAbortSteps = Symbol("[[runAbortSteps]]");
  const abortReason = Symbol("[[abortReason]]");
  const abortAlgos = Symbol("[[abortAlgos]]");
  const dependent = Symbol("[[dependent]]");
  const sourceSignals = Symbol("[[sourceSignals]]");
  const dependentSignals = Symbol("[[dependentSignals]]");
  const timerId = Symbol("[[timerId]]");

  // "Illegal constructor" key — `AbortSignal`'s constructor throws unless
  // called with this private symbol (so `new AbortSignal()` from user
  // code throws, but `AbortSignal.abort()`/`timeout()`/`any()` and
  // `AbortController` can mint instances internally).
  const illegalConstructorKey = Symbol("illegalConstructorKey");

  class AbortSignal extends EventTarget {
    // Per-instance slots (class fields — defaults match spec).
    [abortReason] = undefined;
    [abortAlgos] = null;
    [dependent] = false;
    [sourceSignals] = null;
    [dependentSignals] = null;
    [timerId] = null;

    constructor(key = null) {
      if (key !== illegalConstructorKey) {
        throw new TypeError("Illegal constructor");
      }
      super();
    }

    static abort(reason = undefined) {
      if (reason !== undefined) {
        reason = webidl.converters.any(reason);
      }
      const signal = new AbortSignal(illegalConstructorKey);
      signal[signalAbort](reason);
      return signal;
    }

    static timeout(millis) {
      const prefix = "Failed to execute 'AbortSignal.timeout'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      millis = webidl.converters["unsigned long long"](
        millis,
        prefix,
        "Argument 1",
        { enforceRange: true },
      );

      const signal = new AbortSignal(illegalConstructorKey);
      // Schedule a one-shot timer that aborts the signal with a
      // `TimeoutError` DOMException when it fires. Uses the same timer
      // wheel as `setTimeout` (`op_timer_schedule`); the timer ID is
      // stashed so a later `signal[signalAbort]` could clear it (not
      // strictly needed — once aborted, the timer fires into a no-op —
      // but kept for spec alignment with Deno's `core.cancelTimer`).
      const timerIdVal = op_timer_schedule(
        () => {
          signal[timerId] = null;
          signal[signalAbort](
            new DOMException(
              "The operation was aborted due to timeout",
              "TimeoutError",
            ),
          );
        },
        millis,
        false,
      );
      signal[timerId] = timerIdVal;
      return signal;
    }

    static any(signals) {
      const prefix = "Failed to execute 'AbortSignal.any'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      return createDependentAbortSignal(signals, prefix);
    }

    [signalAbort](
      reason = new DOMException("The signal has been aborted", "AbortError"),
    ) {
      if (this[abortReason] !== undefined) {
        return;
      }
      this[abortReason] = reason;

      // Collect dependent signals to abort (propagate the reason), in
      // creation order. Per spec, dependents inherit the source's reason
      // *before* the source fires its own abort event — so when a
      // dependent's listener runs, `dependent.aborted` is already `true`
      // and `dependent.reason` is set. But the *events* fire in order:
      // source first, then dependents in creation order. So we set the
      // reason on all dependents now, fire the source's listeners, then
      // fire each dependent's listeners.
      const dependentSignalsToAbort = [];
      if (this[dependentSignals] !== null) {
        for (const dep of this[dependentSignals]) {
          if (
            dep[abortReason] === undefined
          ) {
            dep[abortReason] = this[abortReason];
            ArrayPrototypePush(dependentSignalsToAbort, dep);
          }
        }
      }

      // Fire the source's own abort steps (its listeners) FIRST.
      this[runAbortSteps]();

      // Then fire each dependent's abort steps in creation order.
      if (dependentSignalsToAbort.length !== 0) {
        for (let i = 0; i < dependentSignalsToAbort.length; ++i) {
          dependentSignalsToAbort[i][runAbortSteps]();
        }
      }
    }

    [runAbortSteps]() {
      const algos = this[abortAlgos];
      this[abortAlgos] = null;

      if (algos !== null) {
        for (const algorithm of algos) {
          algorithm();
        }
      }

      // Dispatch the `"abort"` event if there are listeners (spec: only
      // fire if `listenerCount(this, "abort") > 0` — an optimization Deno
      // also makes; the previous Rust code always dispatched, which is
      // observable via `onabort` set after abort — kept the spec
      // behavior here).
      if (listenerCount(this, "abort") > 0) {
        const event = new Event("abort");
        setIsTrusted(event, true);
        // `super.dispatchEvent` — call `EventTarget.prototype.dispatchEvent`
        // directly (not `this.dispatchEvent`, which `AbortSignal` doesn't
        // override in this impl — but using the prototype method is
        // explicit and matches Deno's `super.dispatchEvent`).
        EventTargetPrototype.dispatchEvent.call(this, event);
      }
    }

    // `[add]`/`[remove]` — internal abort-algorithm registration used by
    // the Streams Standard (`pipeTo`'s abort wiring, `WritableStream`'s
    // abort). `[add](algorithm)` registers a one-shot algorithm that runs
    // when the signal aborts (no-op if already aborted); `[remove]`
    // detaches it. Matches Deno's `03_abort_signal.js` symbol-keyed
    // methods. Stored as a plain Array (not a Set) so we don't need the
    // `SetPrototypeAdd`/`SetPrototypeDelete` primordials; abort-algorithm
    // lists are tiny so the linear scan is fine.
    [add](algorithm) {
      if (this[abortReason] !== undefined) {
        return;
      }
      if (this[abortAlgos] === null) {
        this[abortAlgos] = [];
      }
      ArrayPrototypePush(this[abortAlgos], algorithm);
    }

    [remove](algorithm) {
      const algos = this[abortAlgos];
      if (algos === null) {
        return;
      }
      for (let i = 0; i < algos.length; ++i) {
        if (algos[i] === algorithm) {
          ArrayPrototypeSplice(algos, i, 1);
          return;
        }
      }
    }

    get aborted() {
      webidl.assertBranded(this, AbortSignalPrototype, "AbortSignal");
      return this[abortReason] !== undefined;
    }

    get reason() {
      webidl.assertBranded(this, AbortSignalPrototype, "AbortSignal");
      return this[abortReason];
    }

    throwIfAborted() {
      webidl.assertBranded(this, AbortSignalPrototype, "AbortSignal");
      if (this[abortReason] !== undefined) {
        throw this[abortReason];
      }
    }
  }

  // `onabort` event handler attribute on `AbortSignal` (DOM §2.11). Any
  // `EventTarget` subclass can expose `on<event>` via the same
  // `defineEventHandler` call.
  defineEventHandler(AbortSignal.prototype, "abort");

  const AbortSignalPrototype = AbortSignal.prototype;
  ObjectDefineProperty(AbortSignalPrototype, SymbolToStringTag, {
    __proto__: null,
    value: "AbortSignal",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // --- AbortController ----------------------------------------------------

  const signalSlot = Symbol("[[signal]]");

  class AbortController {
    [signalSlot] = new AbortSignal(illegalConstructorKey);

    constructor() {
      this[webidl.brand] = webidl.brand;
    }

    get signal() {
      webidl.assertBranded(this, AbortControllerPrototype, "AbortController");
      return this[signalSlot];
    }

    abort(reason) {
      webidl.assertBranded(this, AbortControllerPrototype, "AbortController");
      this[signalSlot][signalAbort](reason);
    }
  }

  const AbortControllerPrototype = AbortController.prototype;
  ObjectDefineProperty(AbortControllerPrototype, SymbolToStringTag, {
    __proto__: null,
    value: "AbortController",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // --- AbortSignal.any() dependent-signal wiring ---------------------------

  // `createDependentAbortSignal(signals, prefix)` — the core of
  // `AbortSignal.any()`. Returns a new signal that aborts when *any* of
  // the input signals aborts, with the same reason. If any input is
  // already aborted, the new signal aborts immediately with that
  // input's reason (first aborted input wins).
  //
  // Dependent tracking: each non-dependent (source) signal maintains a
  // `dependentSignals` array of signals that depend on it. When a
  // source aborts, `signalAbort` propagates the reason to its
  // dependents and fires their events in creation order (see
  // `signalAbort` above). Dependent signals (themselves created via
  // `.any()`) are transparent: we walk through their `sourceSignals` to
  // find the underlying non-dependent sources, so all dependents link
  // directly to real sources (spec: "All dependents are linked to
  // `controller.signal` (never to another composite signal)").
  function createDependentAbortSignal(signals, prefix) {
    // Convert to an array of AbortSignal instances. Tolerate non-
    // iterables by treating them as empty (matches the previous Rust
    // tolerance — though the spec throws `TypeError` here).
    let signalArray;
    if (signals && typeof signals[Symbol.iterator] === "function") {
      signalArray = ArrayPrototypeSlice(signals);
    } else {
      signalArray = [];
    }

    const resultSignal = new AbortSignal(illegalConstructorKey);

    // First pass: if any input is already aborted, abort `resultSignal`
    // immediately with the first aborted input's reason and return.
    for (let i = 0; i < signalArray.length; ++i) {
      const signal = signalArray[i];
      if (signal[abortReason] !== undefined) {
        resultSignal[abortReason] = signal[abortReason];
        return resultSignal;
      }
    }

    resultSignal[dependent] = true;
    resultSignal[sourceSignals] = [];

    // Wire up each source. For a dependent input, walk through its
    // `sourceSignals` to find the underlying non-dependent sources
    // (flatten the chain). Dedup so we don't register the same source
    // twice.
    for (let i = 0; i < signalArray.length; ++i) {
      const signal = signalArray[i];
      if (!signal[dependent]) {
        addSourceToDependent(resultSignal, signal);
      } else {
        // Dependent input: flatten to its underlying sources.
        if (signal[sourceSignals] !== null) {
          for (let j = 0; j < signal[sourceSignals].length; ++j) {
            const sourceSignal = signal[sourceSignals][j];
            // `sourceSignal` is non-dependent by construction (we only
            // store non-dependent sources in `sourceSignals`).
            addSourceToDependent(resultSignal, sourceSignal);
          }
        }
      }
    }

    return resultSignal;
  }

  // Link `resultSignal` (a dependent) to `sourceSignal` (a non-dependent
  // source). Adds the source to `resultSignal[sourceSignals]` (deduped)
  // and `resultSignal` to `sourceSignal[dependentSignals]` (creation
  // order — array push, so later dependents come after earlier ones).
  function addSourceToDependent(resultSignal, sourceSignal) {
    // Dedup: don't add the same source twice.
    for (let i = 0; i < resultSignal[sourceSignals].length; ++i) {
      if (resultSignal[sourceSignals][i] === sourceSignal) {
        return;
      }
    }
    ArrayPrototypePush(resultSignal[sourceSignals], sourceSignal);
    if (sourceSignal[dependentSignals] === null) {
      sourceSignal[dependentSignals] = [];
    }
    ArrayPrototypePush(sourceSignal[dependentSignals], resultSignal);
  }

  // --- Install as non-enumerable globals ----------------------------------

  // All five are constructible interface objects — non-enumerable on
  // `globalThis` (Web IDL §3.7.5), matching the previous Rust `set_global`
  // (DONT_ENUM) and every browser: `Object.keys(globalThis)` excludes
  // `Event`, `EventTarget`, etc.
  function installGlobal(name, ctor) {
    ObjectDefineProperty(globalThis, name, {
      __proto__: null,
      value: ctor,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  installGlobal("Event", Event);
  installGlobal("CustomEvent", CustomEvent);
  installGlobal("EventTarget", EventTarget);
  installGlobal("AbortSignal", AbortSignal);
  installGlobal("AbortController", AbortController);

  // `webidl.converters.AbortSignal` — interface converter used by the
  // Streams Standard (`StreamPipeOptions.signal`, `pipeTo`). Registered
  // here (where `AbortSignal` is defined) rather than in `00_webidl.js`
  // (which can't reference an interface defined in a later module).
  // Matches Deno's `03_abort_signal.js` placement.
  webidl.converters.AbortSignal = webidl.createInterfaceConverter(
    "AbortSignal",
    AbortSignalPrototype,
  );
  webidl.converters["sequence<AbortSignal>"] = webidl.createSequenceConverter(
    webidl.converters.AbortSignal,
  );

  // Expose the internal abort-signal surface the Streams Standard needs
  // (`pipeTo`'s abort wiring, `WritableStream`'s controller signal). These
  // are not part of the public web API — only consumed by `06_streams.js`.
  globalThis.__bootstrap.abortSignal = {
    AbortSignalPrototype,
    signalAbort,
    add,
    remove,
    newSignal: () => new AbortSignal(illegalConstructorKey),
  };

  // Expose the internal event surface `13_message_port.js` needs:
  //   - `defineEventHandler(emitter, name, onFirstSet?)` — install an
  //     `on<name>` handler attribute on `emitter` (usually a prototype).
  //     The optional third arg is called the first time a handler is
  //     set (used by `MessagePort` to imply `start()` on `onmessage`).
  //   - `setIsTrusted(event, bool)` — mark an internally-dispatched
  //     event as trusted (MessagePort messages are trusted per spec).
  // Not part of the public web API — only consumed by
  // `13_message_port.js`.
  globalThis.__bootstrap.event = {
    defineEventHandler,
    setIsTrusted,
  };
})(globalThis);