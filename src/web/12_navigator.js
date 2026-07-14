// Copyright 2026 the Limun authors. MIT license.

// `navigator` global — HTML Navigator interface
// (https://html.spec.whatwg.org/multipage/system-state.html#the-navigator-interface).
// The `Navigator` interface exposes a number of readonly attributes describing
// the user agent and execution environment.  Limun implements a minimal subset:
// `userAgent`, `hardwareConcurrency`, `language`, `languages`, `platform`, and
// `onLine`.  Other Navigator attributes (e.g. `appCodeName`, `vendor`) are not
// exposed because they are compatibility-fiction for browsers and are not
// useful for a non-browser runtime.
//
// The spec surface lives here in JS; `hardwareConcurrency` and `platform` are
// backed by thin Rust ops (`op_navigator_hardware_concurrency`,
// `op_navigator_platform`).  The remaining attributes are constants.
//
// `navigator` is installed as an enumerable own property on `globalThis`,
// matching browsers and Deno.

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const { op_navigator_hardware_concurrency, op_navigator_platform } =
    globalThis.__limunOps;
  const {
    ObjectDefineProperty,
    ObjectFreeze,
    SymbolToStringTag,
  } = primordials;

  const illegalConstructorKey = Symbol("illegalConstructorKey");
  const userAgent = "Limun/0.0.1";
  const language = "en-US";
  const languages = ObjectFreeze([language, "en"]);

  class Navigator {
    constructor(key = null) {
      if (key !== illegalConstructorKey) {
        webidl.illegalConstructor();
      }
      this[webidl.brand] = webidl.brand;
    }

    get userAgent() {
      webidl.assertBranded(this, NavigatorPrototype, "Navigator");
      return userAgent;
    }

    get hardwareConcurrency() {
      webidl.assertBranded(this, NavigatorPrototype, "Navigator");
      return op_navigator_hardware_concurrency();
    }

    get language() {
      webidl.assertBranded(this, NavigatorPrototype, "Navigator");
      return language;
    }

    get languages() {
      webidl.assertBranded(this, NavigatorPrototype, "Navigator");
      return languages;
    }

    get platform() {
      webidl.assertBranded(this, NavigatorPrototype, "Navigator");
      return op_navigator_platform();
    }

    get onLine() {
      webidl.assertBranded(this, NavigatorPrototype, "Navigator");
      return true;
    }
  }

  const NavigatorPrototype = Navigator.prototype;
  ObjectDefineProperty(NavigatorPrototype, SymbolToStringTag, {
    __proto__: null,
    value: "Navigator",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  globalThis.navigator = new Navigator(illegalConstructorKey);
})(globalThis);
