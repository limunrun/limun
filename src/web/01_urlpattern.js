// Copyright 2018-2026 the Deno authors. MIT license.
// Copyright 2026 the Limun authors. MIT license.

// `URLPattern` — WHATWG URL Pattern API
// (https://urlpattern.spec.whatwg.org/).
//
// This is a pure-JS implementation ported from the `urlpattern-polyfill`
// package (https://github.com/kenchris/urlpattern-polyfill, MIT license).
// The spec surface lives here in JS; no Rust op is required.  It builds on
// the existing `URL` global (installed by `ext:limun/00_url.js`) for component
// canonicalization and uses the shared WebIDL infrastructure for argument
// conversion.
//
// Rewires vs the upstream polyfill:
//   - `__bootstrap` / `primordials` are taken from `globalThis.__bootstrap`.
//   - Argument validation is done via `globalThis.__bootstrap.webidl` to match
//     Deno/Limun conventions.
//   - Direct global constructor usage is replaced by the available primordials
//     where practical.
//   - The module exposes `URLPattern` as a non-enumerable global.

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const webidl = globalThis.__bootstrap.webidl;
  const {
    Array,
    ArrayPrototypeEntries,
    ArrayPrototypePush,
    ArrayPrototypeSome,
    MathMin,
    Number,
    ObjectAssign,
    ObjectCreate,
    ObjectDefineProperty,
    ObjectFreeze,
    RegExp,
    RegExpPrototypeExec,
    RegExpPrototypeTest,
    SafeSet,
    String,
    StringPrototypeCharAt,
    StringPrototypeEndsWith,
    StringPrototypeIndexOf,
    StringPrototypeLastIndexOf,
    StringPrototypeReplace,
    StringPrototypeSlice,
    StringPrototypeStartsWith,
    StringPrototypeSubstring,
    StringPrototypeSubstr,
    StringPrototypeToLowerCase,
    StringPrototypeToWellFormed,
    Symbol,
    SymbolToStringTag,
    TypeError,
  } = primordials;

  const URL = globalThis.URL;
  const StringPrototypeLength = (s) => s.length;

  // ---------------------------------------------------------------------------
  // path-to-regex-modified
  // ---------------------------------------------------------------------------

  const Modifier = {
    kZeroOrMore: 0,
    kOptional: 1,
    kOneOrMore: 2,
    kNone: 3,
  };

  const PartType = {
    kFullWildcard: 0,
    kSegmentWildcard: 1,
    kRegex: 2,
    kFixed: 3,
  };

  const kFullWildcardRegex = ".*";

  class Part {
    type = PartType.kFixed;
    name = "";
    prefix = "";
    value = "";
    suffix = "";
    modifier = Modifier.kNone;

    constructor(type, name, prefix, value, suffix, modifier) {
      this.type = type;
      this.name = name;
      this.prefix = prefix;
      this.value = value;
      this.suffix = suffix;
      this.modifier = modifier;
    }

    hasCustomName() {
      return this.name !== "" && typeof this.name !== "number";
    }
  }

  const regexIdentifierStart = new RegExp("[$_\\p{ID_Start}]", "u");
  const regexIdentifierPart = new RegExp("[$_\\u200C\\u200D\\p{ID_Continue}]", "u");

  function isASCII(str, extended) {
    return (extended ? /^[\x00-\xFF]*$/ : /^[\x00-\x7F]*$/).test(str);
  }

  function lexer(str, lenient = false) {
    const tokens = [];
    let i = 0;

    while (i < StringPrototypeLength(str)) {
      const char = StringPrototypeCharAt(str, i);

      const ErrorOrInvalid = (msg) => {
        if (!lenient) throw new TypeError(msg);
        ArrayPrototypePush(tokens, { type: "INVALID_CHAR", index: i, value: StringPrototypeCharAt(str, i++) });
      };

      if (char === "*") {
        ArrayPrototypePush(tokens, { type: "ASTERISK", index: i, value: StringPrototypeCharAt(str, i++) });
        continue;
      }

      if (char === "+" || char === "?") {
        ArrayPrototypePush(tokens, { type: "OTHER_MODIFIER", index: i, value: StringPrototypeCharAt(str, i++) });
        continue;
      }

      if (char === "\\") {
        ArrayPrototypePush(tokens, { type: "ESCAPED_CHAR", index: i++, value: StringPrototypeCharAt(str, i++) });
        continue;
      }

      if (char === "{") {
        ArrayPrototypePush(tokens, { type: "OPEN", index: i, value: StringPrototypeCharAt(str, i++) });
        continue;
      }

      if (char === "}") {
        ArrayPrototypePush(tokens, { type: "CLOSE", index: i, value: StringPrototypeCharAt(str, i++) });
        continue;
      }

      if (char === ":") {
        let name = "";
        let j = i + 1;

        while (j < StringPrototypeLength(str)) {
          const code = StringPrototypeSubstr(str, j, 1);

          if (
            (j === i + 1 && RegExpPrototypeTest(regexIdentifierStart, code)) ||
            (j !== i + 1 && RegExpPrototypeTest(regexIdentifierPart, code))
          ) {
            name += StringPrototypeCharAt(str, j++);
            continue;
          }

          break;
        }

        if (!name) {
          ErrorOrInvalid(`Missing parameter name at ${i}`);
          continue;
        }

        ArrayPrototypePush(tokens, { type: "NAME", index: i, value: name });
        i = j;
        continue;
      }

      if (char === "(") {
        let count = 1;
        let pattern = "";
        let j = i + 1;
        let error = false;

        if (StringPrototypeCharAt(str, j) === "?") {
          ErrorOrInvalid(`Pattern cannot start with "?" at ${j}`);
          continue;
        }

        while (j < StringPrototypeLength(str)) {
          if (!isASCII(StringPrototypeCharAt(str, j), false)) {
            ErrorOrInvalid(`Invalid character '${StringPrototypeCharAt(str, j)}' at ${j}.`);
            error = true;
            break;
          }

          if (StringPrototypeCharAt(str, j) === "\\") {
            pattern += StringPrototypeCharAt(str, j++) + StringPrototypeCharAt(str, j++);
            continue;
          }

          if (StringPrototypeCharAt(str, j) === ")") {
            count--;
            if (count === 0) {
              j++;
              break;
            }
          } else if (StringPrototypeCharAt(str, j) === "(") {
            count++;
            if (StringPrototypeCharAt(str, j + 1) !== "?") {
              ErrorOrInvalid(`Capturing groups are not allowed at ${j}`);
              error = true;
              break;
            }
          }

          pattern += StringPrototypeCharAt(str, j++);
        }

        if (error) {
          continue;
        }

        if (count) {
          ErrorOrInvalid(`Unbalanced pattern at ${i}`);
          continue;
        }
        if (!pattern) {
          ErrorOrInvalid(`Missing pattern at ${i}`);
          continue;
        }

        ArrayPrototypePush(tokens, { type: "REGEX", index: i, value: pattern });
        i = j;
        continue;
      }

      ArrayPrototypePush(tokens, { type: "CHAR", index: i, value: StringPrototypeCharAt(str, i++) });
    }

    ArrayPrototypePush(tokens, { type: "END", index: i, value: "" });

    return tokens;
  }

  function DefaultEncodePart(value) {
    return value;
  }

  function parse(str, options = {}) {
    const tokens = lexer(str);

    if (options.delimiter === undefined) options.delimiter = "/#?";
    if (options.prefixes === undefined) options.prefixes = "./";

    const segmentWildcardRegex = `[^${escapeString(options.delimiter)}]+?`;
    const result = [];
    let key = 0;
    let i = 0;
    let nameSet = new SafeSet();

    const tryConsume = (type) => {
      if (i < tokens.length && tokens[i].type === type) return tokens[i++].value;
    };

    const tryConsumeModifier = () => {
      return tryConsume("OTHER_MODIFIER") ?? tryConsume("ASTERISK");
    };

    const mustConsume = (type) => {
      const value = tryConsume(type);
      if (value !== undefined) return value;
      const { type: nextType, index } = tokens[i];
      throw new TypeError(`Unexpected ${nextType} at ${index}, expected ${type}`);
    };

    const consumeText = () => {
      let result = "";
      let value;
      while ((value = tryConsume("CHAR") ?? tryConsume("ESCAPED_CHAR"))) {
        result += value;
      }
      return result;
    };

    const encodePart = options.encodePart || DefaultEncodePart;

    let pendingFixedValue = "";
    const appendToPendingFixedValue = (value) => {
      pendingFixedValue += value;
    };

    const maybeAddPartFromPendingFixedValue = () => {
      if (!pendingFixedValue.length) {
        return;
      }

      ArrayPrototypePush(result, new Part(PartType.kFixed, "", "", encodePart(pendingFixedValue), "", Modifier.kNone));
      pendingFixedValue = "";
    };

    const addPart = (prefix, nameToken, regexOrWildcardToken, suffix, modifierToken) => {
      let modifier = Modifier.kNone;
      switch (modifierToken) {
        case "?":
          modifier = Modifier.kOptional;
          break;
        case "*":
          modifier = Modifier.kZeroOrMore;
          break;
        case "+":
          modifier = Modifier.kOneOrMore;
          break;
      }

      if (!nameToken && !regexOrWildcardToken && modifier === Modifier.kNone) {
        appendToPendingFixedValue(prefix);
        return;
      }

      maybeAddPartFromPendingFixedValue();

      if (!nameToken && !regexOrWildcardToken) {
        if (!prefix) {
          return;
        }

        ArrayPrototypePush(result, new Part(PartType.kFixed, "", "", encodePart(prefix), "", modifier));
        return;
      }

      let regexValue;
      if (!regexOrWildcardToken) {
        regexValue = segmentWildcardRegex;
      } else if (regexOrWildcardToken === "*") {
        regexValue = kFullWildcardRegex;
      } else {
        regexValue = regexOrWildcardToken;
      }

      let type = PartType.kRegex;
      if (regexValue === segmentWildcardRegex) {
        type = PartType.kSegmentWildcard;
        regexValue = "";
      } else if (regexValue === kFullWildcardRegex) {
        type = PartType.kFullWildcard;
        regexValue = "";
      }

      let name;
      if (nameToken) {
        name = nameToken;
      } else if (regexOrWildcardToken) {
        name = key++;
      }

      if (nameSet.has(name)) {
        throw new TypeError(`Duplicate name '${name}'.`);
      }
      nameSet.add(name);

      ArrayPrototypePush(result, new Part(type, name, encodePart(prefix), regexValue, encodePart(suffix), modifier));
    };

    while (i < tokens.length) {
      const charToken = tryConsume("CHAR");
      const nameToken = tryConsume("NAME");
      let regexOrWildcardToken = tryConsume("REGEX");

      if (!nameToken && !regexOrWildcardToken) {
        regexOrWildcardToken = tryConsume("ASTERISK");
      }

      if (nameToken || regexOrWildcardToken) {
        let prefix = charToken ?? "";
        if (StringPrototypeIndexOf(options.prefixes, prefix) === -1) {
          appendToPendingFixedValue(prefix);
          prefix = "";
        }

        maybeAddPartFromPendingFixedValue();

        const modifierToken = tryConsumeModifier();

        addPart(prefix, nameToken, regexOrWildcardToken, "", modifierToken);

        continue;
      }

      const value = charToken ?? tryConsume("ESCAPED_CHAR");
      if (value) {
        appendToPendingFixedValue(value);
        continue;
      }

      const openToken = tryConsume("OPEN");
      if (openToken) {
        const prefix = consumeText();
        const nameToken = tryConsume("NAME");
        let regexOrWildcardToken = tryConsume("REGEX");

        if (!nameToken && !regexOrWildcardToken) {
          regexOrWildcardToken = tryConsume("ASTERISK");
        }

        const suffix = consumeText();

        mustConsume("CLOSE");

        const modifierToken = tryConsumeModifier();

        addPart(prefix, nameToken, regexOrWildcardToken, suffix, modifierToken);
        continue;
      }

      maybeAddPartFromPendingFixedValue();

      mustConsume("END");
    }

    return result;
  }

  function escapeString(str) {
    return StringPrototypeReplace(str, /([.+*?^${}()|[\]\/\\])/g, "\\$1");
  }

  function flags(options) {
    return options && options.ignoreCase ? "ui" : "u";
  }

  function modifierToString(modifier) {
    switch (modifier) {
      case Modifier.kZeroOrMore:
        return "*";
      case Modifier.kOptional:
        return "?";
      case Modifier.kOneOrMore:
        return "+";
      case Modifier.kNone:
        return "";
    }
  }

  function partsToRegexp(parts, names, options = {}) {
    if (options.delimiter === undefined) options.delimiter = "/#?";
    if (options.prefixes === undefined) options.prefixes = "./";
    if (options.sensitive === undefined) options.sensitive = false;
    if (options.strict === undefined) options.strict = false;
    if (options.end === undefined) options.end = true;
    if (options.start === undefined) options.start = true;
    options.endsWith = "";

    let result = options.start ? "^" : "";

    for (const part of parts) {
      if (part.type === PartType.kFixed) {
        if (part.modifier === Modifier.kNone) {
          result += escapeString(part.value);
        } else {
          result += `(?:${escapeString(part.value)})${modifierToString(part.modifier)}`;
        }
        continue;
      }

      if (names) ArrayPrototypePush(names, part.name);

      const segmentWildcardRegex = `[^${escapeString(options.delimiter)}]+?`;

      let regexValue = part.value;
      if (part.type === PartType.kSegmentWildcard) {
        regexValue = segmentWildcardRegex;
      } else if (part.type === PartType.kFullWildcard) {
        regexValue = kFullWildcardRegex;
      }

      if (!part.prefix.length && !part.suffix.length) {
        if (part.modifier === Modifier.kNone || part.modifier === Modifier.kOptional) {
          result += `(${regexValue})${modifierToString(part.modifier)}`;
        } else {
          result += `((?:${regexValue})${modifierToString(part.modifier)})`;
        }
        continue;
      }

      if (part.modifier === Modifier.kNone || part.modifier === Modifier.kOptional) {
        result += `(?:${escapeString(part.prefix)}(${regexValue})${escapeString(part.suffix)})`;
        result += modifierToString(part.modifier);
        continue;
      }

      result += `(?:${escapeString(part.prefix)}`;
      result += `((?:${regexValue})(?:`;
      result += escapeString(part.suffix);
      result += escapeString(part.prefix);
      result += `(?:${regexValue}))*)${escapeString(part.suffix)})`;
      if (part.modifier === Modifier.kZeroOrMore) {
        result += "?";
      }
    }

    const endsWith = `[${escapeString(options.endsWith)}]|$`;
    const delimiter = `[${escapeString(options.delimiter)}]`;

    if (options.end) {
      if (!options.strict) {
        result += `${delimiter}?`;
      }

      if (!options.endsWith.length) {
        result += "$";
      } else {
        result += `(?=${endsWith})`;
      }
      return new RegExp(result, flags(options));
    }

    if (!options.strict) {
      result += `(?:${delimiter}(?=${endsWith}))?`;
    }

    let isEndDelimited = false;
    if (parts.length) {
      const lastPart = parts[parts.length - 1];
      if (lastPart.type === PartType.kFixed && lastPart.modifier === Modifier.kNone) {
        isEndDelimited = StringPrototypeIndexOf(options.delimiter, lastPart) > -1;
      }
    }

    if (!isEndDelimited) {
      result += `(?=${delimiter}|${endsWith})`;
    }

    return new RegExp(result, flags(options));
  }

  function stringToRegexp(path, names, options) {
    return partsToRegexp(parse(path, options), names, options);
  }

  // ---------------------------------------------------------------------------
  // url-utils
  // ---------------------------------------------------------------------------

  const DEFAULT_OPTIONS = {
    delimiter: "",
    prefixes: "",
    sensitive: true,
    strict: true,
  };

  const HOSTNAME_OPTIONS = {
    delimiter: ".",
    prefixes: "",
    sensitive: true,
    strict: true,
  };

  const PATHNAME_OPTIONS = {
    delimiter: "/",
    prefixes: "/",
    sensitive: true,
    strict: true,
  };

  const SPECIAL_SCHEMES = ["ftp", "file", "http", "https", "ws", "wss"];

  function maybeStripPrefix(value, prefix) {
    if (StringPrototypeStartsWith(value, prefix)) {
      return StringPrototypeSubstring(value, StringPrototypeLength(prefix), StringPrototypeLength(value));
    }
    return value;
  }

  function maybeStripSuffix(value, suffix) {
    if (StringPrototypeEndsWith(value, suffix)) {
      return StringPrototypeSubstr(value, 0, StringPrototypeLength(value) - StringPrototypeLength(suffix));
    }
    return value;
  }

  function isAbsolutePathname(pathname, isPattern) {
    if (!pathname.length) {
      return false;
    }

    if (pathname[0] === "/") {
      return true;
    }

    if (!isPattern) {
      return false;
    }

    if (pathname.length < 2) {
      return false;
    }

    if ((pathname[0] === "\\" || pathname[0] === "{") && pathname[1] === "/") {
      return true;
    }

    return false;
  }

  function treatAsIPv6Hostname(value) {
    if (!value || value.length < 2) {
      return false;
    }

    if (value[0] === "[") {
      return true;
    }

    if ((value[0] === "\\" || value[0] === "{") && value[1] === "[") {
      return true;
    }

    return false;
  }

  function isSpecialScheme(protocol_regexp) {
    if (!protocol_regexp) {
      return true;
    }
    for (const scheme of SPECIAL_SCHEMES) {
      if (RegExpPrototypeTest(protocol_regexp, scheme)) {
        return true;
      }
    }
    return false;
  }

  function canonicalizeHash(hash, isPattern) {
    hash = maybeStripPrefix(hash, "#");
    if (isPattern || hash === "") {
      return hash;
    }
    const url = new URL("https://example.com");
    url.hash = hash;
    return url.hash ? StringPrototypeSubstring(url.hash, 1, StringPrototypeLength(url.hash)) : "";
  }

  function canonicalizeSearch(search, isPattern) {
    search = maybeStripPrefix(search, "?");
    if (isPattern || search === "") {
      return search;
    }
    const url = new URL("https://example.com");
    url.search = search;
    return url.search ? StringPrototypeSubstring(url.search, 1, StringPrototypeLength(url.search)) : "";
  }

  function canonicalizeHostname(hostname, isPattern) {
    if (isPattern || hostname === "") {
      return hostname;
    }
    if (treatAsIPv6Hostname(hostname)) {
      return ipv6HostnameEncodeCallback(hostname);
    } else {
      return hostnameEncodeCallback(hostname);
    }
  }

  function canonicalizePassword(password, isPattern) {
    if (isPattern || password === "") {
      return password;
    }
    const url = new URL("https://example.com");
    url.password = password;
    return url.password;
  }

  function canonicalizeUsername(username, isPattern) {
    if (isPattern || username === "") {
      return username;
    }
    const url = new URL("https://example.com");
    url.username = username;
    return url.username;
  }

  function canonicalizePathname(pathname, protocol, isPattern) {
    if (isPattern || pathname === "") {
      return pathname;
    }

    if (protocol && !ArrayPrototypeSome(SPECIAL_SCHEMES, (s) => s === protocol)) {
      const url = new URL(`${protocol}:${pathname}`);
      return url.pathname;
    }

    const leadingSlash = pathname[0] === "/";
    pathname = new URL(leadingSlash ? pathname : "/-" + pathname, "https://example.com").pathname;
    if (!leadingSlash) {
      pathname = StringPrototypeSubstring(pathname, 2, StringPrototypeLength(pathname));
    }

    return pathname;
  }

  function canonicalizePort(port, protocol, isPattern) {
    if (defaultPortForProtocol(protocol) === port) {
      port = "";
    }

    if (isPattern || port === "") {
      return port;
    }

    return portEncodeCallback(port);
  }

  function canonicalizeProtocol(protocol, isPattern) {
    protocol = maybeStripSuffix(protocol, ":");

    if (isPattern || protocol === "") {
      return protocol;
    }

    return protocolEncodeCallback(protocol);
  }

  function defaultPortForProtocol(protocol) {
    switch (protocol) {
      case "ws":
      case "http":
        return "80";
      case "wws":
      case "https":
        return "443";
      case "ftp":
        return "21";
      default:
        return "";
    }
  }

  function protocolEncodeCallback(input) {
    if (input === "") {
      return input;
    }
    if (/^[-+.A-Za-z0-9]*$/.test(input)) {
      return StringPrototypeToLowerCase(input);
    }
    throw new TypeError(`Invalid protocol '${input}'.`);
  }

  function usernameEncodeCallback(input) {
    if (input === "") {
      return input;
    }
    const url = new URL("https://example.com");
    url.username = input;
    return url.username;
  }

  function passwordEncodeCallback(input) {
    if (input === "") {
      return input;
    }
    const url = new URL("https://example.com");
    url.password = input;
    return url.password;
  }

  function hostnameEncodeCallback(input) {
    if (input === "") {
      return input;
    }
    if (/[\t\n\r #%\/:<>?@[\]^\\|]/g.test(input)) {
      throw new TypeError(`Invalid hostname '${input}'`);
    }
    const url = new URL("https://example.com");
    url.hostname = input;
    return url.hostname;
  }

  function ipv6HostnameEncodeCallback(input) {
    if (input === "") {
      return input;
    }
    if (/[^0-9a-fA-F[\]:]/g.test(input)) {
      throw new TypeError(`Invalid IPv6 hostname '${input}'`);
    }
    return StringPrototypeToLowerCase(input);
  }

  function portEncodeCallback(input) {
    if (input === "") {
      return input;
    }
    if (/^[0-9]*$/.test(input) && Number(input) <= 65535) {
      return input;
    }
    throw new TypeError(`Invalid port '${input}'.`);
  }

  function standardURLPathnameEncodeCallback(input) {
    if (input === "") {
      return input;
    }
    const url = new URL("https://example.com");
    url.pathname = input[0] !== "/" ? "/-" + input : input;
    if (input[0] !== "/") {
      return StringPrototypeSubstring(url.pathname, 2, StringPrototypeLength(url.pathname));
    }
    return url.pathname;
  }

  function pathURLPathnameEncodeCallback(input) {
    if (input === "") {
      return input;
    }
    const url = new URL(`data:${input}`);
    return url.pathname;
  }

  function searchEncodeCallback(input) {
    if (input === "") {
      return input;
    }
    const url = new URL("https://example.com");
    url.search = input;
    return StringPrototypeSubstring(url.search, 1, StringPrototypeLength(url.search));
  }

  function hashEncodeCallback(input) {
    if (input === "") {
      return input;
    }
    const url = new URL("https://example.com");
    url.hash = input;
    return StringPrototypeSubstring(url.hash, 1, StringPrototypeLength(url.hash));
  }

  // ---------------------------------------------------------------------------
  // url-pattern-parser
  // ---------------------------------------------------------------------------

  const State = {
    INIT: 0,
    PROTOCOL: 1,
    AUTHORITY: 2,
    USERNAME: 3,
    PASSWORD: 4,
    HOSTNAME: 5,
    PORT: 6,
    PATHNAME: 7,
    SEARCH: 8,
    HASH: 9,
    DONE: 10,
  };

  class Parser {
    #input;
    #tokenList = [];
    #internalResult = {};
    #tokenIndex = 0;
    #tokenIncrement = 1;
    #componentStart = 0;
    #state = State.INIT;
    #groupDepth = 0;
    #hostnameIPv6BracketDepth = 0;
    #shouldTreatAsStandardURL = false;

    constructor(input) {
      this.#input = input;
    }

    get result() {
      return this.#internalResult;
    }

    parse() {
      this.#tokenList = lexer(this.#input, true);

      for (; this.#tokenIndex < this.#tokenList.length; this.#tokenIndex += this.#tokenIncrement) {
        this.#tokenIncrement = 1;

        if (this.#tokenList[this.#tokenIndex].type === "END") {
          if (this.#state === State.INIT) {
            this.#rewind();

            if (this.#isHashPrefix()) {
              this.#changeState(State.HASH, 1);
            } else if (this.#isSearchPrefix()) {
              this.#changeState(State.SEARCH, 1);
            } else {
              this.#changeState(State.PATHNAME, 0);
            }
            continue;
          } else if (this.#state === State.AUTHORITY) {
            this.#rewindAndSetState(State.HOSTNAME);
            continue;
          }

          this.#changeState(State.DONE, 0);
          break;
        }

        if (this.#groupDepth > 0) {
          if (this.#isGroupClose()) {
            this.#groupDepth -= 1;
          } else {
            continue;
          }
        }

        if (this.#isGroupOpen()) {
          this.#groupDepth += 1;
          continue;
        }

        switch (this.#state) {
          case State.INIT:
            if (this.#isProtocolSuffix()) {
              this.#rewindAndSetState(State.PROTOCOL);
            }
            break;

          case State.PROTOCOL:
            if (this.#isProtocolSuffix()) {
              this.#computeShouldTreatAsStandardURL();

              let nextState = State.PATHNAME;
              let skip = 1;

              if (this.#nextIsAuthoritySlashes()) {
                nextState = State.AUTHORITY;
                skip = 3;
              } else if (this.#shouldTreatAsStandardURL) {
                nextState = State.AUTHORITY;
              }

              this.#changeState(nextState, skip);
            }
            break;

          case State.AUTHORITY:
            if (this.#isIdentityTerminator()) {
              this.#rewindAndSetState(State.USERNAME);
            } else if (this.#isPathnameStart() || this.#isSearchPrefix() || this.#isHashPrefix()) {
              this.#rewindAndSetState(State.HOSTNAME);
            }
            break;

          case State.USERNAME:
            if (this.#isPasswordPrefix()) {
              this.#changeState(State.PASSWORD, 1);
            } else if (this.#isIdentityTerminator()) {
              this.#changeState(State.HOSTNAME, 1);
            }
            break;

          case State.PASSWORD:
            if (this.#isIdentityTerminator()) {
              this.#changeState(State.HOSTNAME, 1);
            }
            break;

          case State.HOSTNAME:
            if (this.#isIPv6Open()) {
              this.#hostnameIPv6BracketDepth += 1;
            } else if (this.#isIPv6Close()) {
              this.#hostnameIPv6BracketDepth -= 1;
            }

            if (this.#isPortPrefix() && !this.#hostnameIPv6BracketDepth) {
              this.#changeState(State.PORT, 1);
            } else if (this.#isPathnameStart()) {
              this.#changeState(State.PATHNAME, 0);
            } else if (this.#isSearchPrefix()) {
              this.#changeState(State.SEARCH, 1);
            } else if (this.#isHashPrefix()) {
              this.#changeState(State.HASH, 1);
            }
            break;

          case State.PORT:
            if (this.#isPathnameStart()) {
              this.#changeState(State.PATHNAME, 0);
            } else if (this.#isSearchPrefix()) {
              this.#changeState(State.SEARCH, 1);
            } else if (this.#isHashPrefix()) {
              this.#changeState(State.HASH, 1);
            }
            break;

          case State.PATHNAME:
            if (this.#isSearchPrefix()) {
              this.#changeState(State.SEARCH, 1);
            } else if (this.#isHashPrefix()) {
              this.#changeState(State.HASH, 1);
            }
            break;

          case State.SEARCH:
            if (this.#isHashPrefix()) {
              this.#changeState(State.HASH, 1);
            }
            break;

          case State.HASH:
            break;

          case State.DONE:
            break;
        }
      }

      if (this.#internalResult.hostname !== undefined && this.#internalResult.port === undefined) {
        this.#internalResult.port = "";
      }
    }

    #changeState(newState, skip) {
      switch (this.#state) {
        case State.INIT:
          break;
        case State.PROTOCOL:
          this.#internalResult.protocol = this.#makeComponentString();
          break;
        case State.AUTHORITY:
          break;
        case State.USERNAME:
          this.#internalResult.username = this.#makeComponentString();
          break;
        case State.PASSWORD:
          this.#internalResult.password = this.#makeComponentString();
          break;
        case State.HOSTNAME:
          this.#internalResult.hostname = this.#makeComponentString();
          break;
        case State.PORT:
          this.#internalResult.port = this.#makeComponentString();
          break;
        case State.PATHNAME:
          this.#internalResult.pathname = this.#makeComponentString();
          break;
        case State.SEARCH:
          this.#internalResult.search = this.#makeComponentString();
          break;
        case State.HASH:
          this.#internalResult.hash = this.#makeComponentString();
          break;
        case State.DONE:
          break;
      }

      if (this.#state !== State.INIT && newState !== State.DONE) {
        if (
          [State.PROTOCOL, State.AUTHORITY, State.USERNAME, State.PASSWORD].includes(this.#state) &&
          [State.PORT, State.PATHNAME, State.SEARCH, State.HASH].includes(newState)
        ) {
          if (this.#internalResult.hostname === undefined) this.#internalResult.hostname = "";
        }
        if (
          [State.PROTOCOL, State.AUTHORITY, State.USERNAME, State.PASSWORD, State.HOSTNAME, State.PORT].includes(this.#state) &&
          [State.SEARCH, State.HASH].includes(newState)
        ) {
          if (this.#internalResult.pathname === undefined) {
            this.#internalResult.pathname = this.#shouldTreatAsStandardURL ? "/" : "";
          }
        }
        if (
          [State.PROTOCOL, State.AUTHORITY, State.USERNAME, State.PASSWORD, State.HOSTNAME, State.PORT, State.PATHNAME].includes(this.#state) &&
          newState === State.HASH
        ) {
          if (this.#internalResult.search === undefined) this.#internalResult.search = "";
        }
      }

      this.#changeStateWithoutSettingComponent(newState, skip);
    }

    #changeStateWithoutSettingComponent(newState, skip) {
      this.#state = newState;
      this.#componentStart = this.#tokenIndex + skip;
      this.#tokenIndex += skip;
      this.#tokenIncrement = 0;
    }

    #rewind() {
      this.#tokenIndex = this.#componentStart;
      this.#tokenIncrement = 0;
    }

    #rewindAndSetState(newState) {
      this.#rewind();
      this.#state = newState;
    }

    #safeToken(index) {
      if (index < 0) {
        index = this.#tokenList.length - index;
      }

      if (index < this.#tokenList.length) {
        return this.#tokenList[index];
      }
      return this.#tokenList[this.#tokenList.length - 1];
    }

    #isNonSpecialPatternChar(index, value) {
      const token = this.#safeToken(index);
      return token.value === value &&
        (token.type === "CHAR" || token.type === "ESCAPED_CHAR" || token.type === "INVALID_CHAR");
    }

    #isProtocolSuffix() {
      return this.#isNonSpecialPatternChar(this.#tokenIndex, ":");
    }

    #nextIsAuthoritySlashes() {
      return this.#isNonSpecialPatternChar(this.#tokenIndex + 1, "/") &&
        this.#isNonSpecialPatternChar(this.#tokenIndex + 2, "/");
    }

    #isIdentityTerminator() {
      return this.#isNonSpecialPatternChar(this.#tokenIndex, "@");
    }

    #isPasswordPrefix() {
      return this.#isNonSpecialPatternChar(this.#tokenIndex, ":");
    }

    #isPortPrefix() {
      return this.#isNonSpecialPatternChar(this.#tokenIndex, ":");
    }

    #isPathnameStart() {
      return this.#isNonSpecialPatternChar(this.#tokenIndex, "/");
    }

    #isSearchPrefix() {
      if (this.#isNonSpecialPatternChar(this.#tokenIndex, "?")) {
        return true;
      }

      if (this.#tokenList[this.#tokenIndex].value !== "?") {
        return false;
      }

      const previousToken = this.#safeToken(this.#tokenIndex - 1);
      return previousToken.type !== "NAME" &&
        previousToken.type !== "REGEX" &&
        previousToken.type !== "CLOSE" &&
        previousToken.type !== "ASTERISK";
    }

    #isHashPrefix() {
      return this.#isNonSpecialPatternChar(this.#tokenIndex, "#");
    }

    #isGroupOpen() {
      return this.#tokenList[this.#tokenIndex].type === "OPEN";
    }

    #isGroupClose() {
      return this.#tokenList[this.#tokenIndex].type === "CLOSE";
    }

    #isIPv6Open() {
      return this.#isNonSpecialPatternChar(this.#tokenIndex, "[");
    }

    #isIPv6Close() {
      return this.#isNonSpecialPatternChar(this.#tokenIndex, "]");
    }

    #makeComponentString() {
      const token = this.#tokenList[this.#tokenIndex];
      const componentCharStart = this.#safeToken(this.#componentStart).index;
      return StringPrototypeSubstring(this.#input, componentCharStart, token.index);
    }

    #computeShouldTreatAsStandardURL() {
      const options = {};
      ObjectAssign(options, DEFAULT_OPTIONS);
      options.encodePart = protocolEncodeCallback;
      const regexp = stringToRegexp(this.#makeComponentString(), undefined, options);
      this.#shouldTreatAsStandardURL = isSpecialScheme(regexp);
    }
  }

  // ---------------------------------------------------------------------------
  // url-pattern
  // ---------------------------------------------------------------------------

  const COMPONENTS = [
    "protocol",
    "username",
    "password",
    "hostname",
    "port",
    "pathname",
    "search",
    "hash",
  ];

  const DEFAULT_PATTERN = "*";

  function extractValues(url, baseURL) {
    if (typeof url !== "string") {
      throw new TypeError("parameter 1 is not of type 'string'.");
    }
    const o = new URL(url, baseURL);
    return {
      protocol: StringPrototypeSubstring(o.protocol, 0, StringPrototypeLength(o.protocol) - 1),
      username: o.username,
      password: o.password,
      hostname: o.hostname,
      port: o.port,
      pathname: o.pathname,
      search: o.search !== "" ? StringPrototypeSubstring(o.search, 1, StringPrototypeLength(o.search)) : undefined,
      hash: o.hash !== "" ? StringPrototypeSubstring(o.hash, 1, StringPrototypeLength(o.hash)) : undefined,
    };
  }

  function processBaseURLString(input, isPattern) {
    if (!isPattern) {
      return input;
    }
    return escapePatternString(input);
  }

  function applyInit(o, init, isPattern) {
    let baseURL;
    if (typeof init.baseURL === "string") {
      try {
        baseURL = new URL(init.baseURL);
        if (init.protocol === undefined) {
          o.protocol = processBaseURLString(
            StringPrototypeSubstring(baseURL.protocol, 0, StringPrototypeLength(baseURL.protocol) - 1),
            isPattern,
          );
        }
        if (
          !isPattern && init.protocol === undefined && init.hostname === undefined &&
          init.port === undefined && init.username === undefined
        ) {
          o.username = processBaseURLString(baseURL.username, isPattern);
        }
        if (
          !isPattern && init.protocol === undefined && init.hostname === undefined &&
          init.port === undefined && init.username === undefined && init.password === undefined
        ) {
          o.password = processBaseURLString(baseURL.password, isPattern);
        }
        if (init.protocol === undefined && init.hostname === undefined) {
          o.hostname = processBaseURLString(baseURL.hostname, isPattern);
        }
        if (init.protocol === undefined && init.hostname === undefined && init.port === undefined) {
          o.port = processBaseURLString(baseURL.port, isPattern);
        }
        if (
          init.protocol === undefined && init.hostname === undefined && init.port === undefined &&
          init.pathname === undefined
        ) {
          o.pathname = processBaseURLString(baseURL.pathname, isPattern);
        }
        if (
          init.protocol === undefined && init.hostname === undefined && init.port === undefined &&
          init.pathname === undefined && init.search === undefined
        ) {
          o.search = processBaseURLString(
            StringPrototypeSubstring(baseURL.search, 1, StringPrototypeLength(baseURL.search)),
            isPattern,
          );
        }
        if (
          init.protocol === undefined && init.hostname === undefined && init.port === undefined &&
          init.pathname === undefined && init.search === undefined && init.hash === undefined
        ) {
          o.hash = processBaseURLString(
            StringPrototypeSubstring(baseURL.hash, 1, StringPrototypeLength(baseURL.hash)),
            isPattern,
          );
        }
      } catch {
        throw new TypeError(`invalid baseURL '${init.baseURL}'.`);
      }
    }

    if (typeof init.protocol === "string") {
      o.protocol = canonicalizeProtocol(init.protocol, isPattern);
    }

    if (typeof init.username === "string") {
      o.username = canonicalizeUsername(init.username, isPattern);
    }

    if (typeof init.password === "string") {
      o.password = canonicalizePassword(init.password, isPattern);
    }

    if (typeof init.hostname === "string") {
      o.hostname = canonicalizeHostname(init.hostname, isPattern);
    }

    if (typeof init.port === "string") {
      o.port = canonicalizePort(init.port, o.protocol, isPattern);
    }

    if (typeof init.pathname === "string") {
      o.pathname = init.pathname;
      if (baseURL && !isAbsolutePathname(o.pathname, isPattern)) {
        const slashIndex = StringPrototypeLastIndexOf(baseURL.pathname, "/");
        if (slashIndex >= 0) {
          o.pathname = processBaseURLString(
            StringPrototypeSubstring(baseURL.pathname, 0, slashIndex + 1),
            isPattern,
          ) + o.pathname;
        }
      }
      o.pathname = canonicalizePathname(o.pathname, o.protocol, isPattern);
    }

    if (typeof init.search === "string") {
      o.search = canonicalizeSearch(init.search, isPattern);
    }

    if (typeof init.hash === "string") {
      o.hash = canonicalizeHash(init.hash, isPattern);
    }

    return o;
  }

  function escapePatternString(value) {
    return StringPrototypeReplace(value, /([+*?:{}()\\])/g, "\\$1");
  }

  function escapeRegexpString(value) {
    return StringPrototypeReplace(value, /([.+*?^${}()[\]|/\\])/g, "\\$1");
  }

  function partsToPattern(parts, options) {
    if (options.delimiter === undefined) options.delimiter = "/#?";
    if (options.prefixes === undefined) options.prefixes = "./";
    if (options.sensitive === undefined) options.sensitive = false;
    if (options.strict === undefined) options.strict = false;
    if (options.end === undefined) options.end = true;
    if (options.start === undefined) options.start = true;
    options.endsWith = "";

    const kFullWildcardRegex = ".*";
    const segmentWildcardRegex = `[^${escapeRegexpString(options.delimiter)}]+?`;

    let result = "";
    for (let i = 0; i < parts.length; ++i) {
      const part = parts[i];

      if (part.type === PartType.kFixed) {
        if (part.modifier === Modifier.kNone) {
          result += escapePatternString(part.value);
          continue;
        }
        result += `{${escapePatternString(part.value)}}${modifierToString(part.modifier)}`;
        continue;
      }

      const customName = part.hasCustomName();

      let needsGrouping = !!part.suffix.length ||
        (!!part.prefix.length &&
          (part.prefix.length !== 1 || StringPrototypeIndexOf(options.prefixes, part.prefix) === -1));

      const lastPart = i > 0 ? parts[i - 1] : null;
      const nextPart = i < parts.length - 1 ? parts[i + 1] : null;

      if (
        !needsGrouping && customName && part.type === PartType.kSegmentWildcard &&
        part.modifier === Modifier.kNone && nextPart && !nextPart.prefix.length && !nextPart.suffix.length
      ) {
        if (nextPart.type === PartType.kFixed) {
          const code = nextPart.value.length > 0 ? nextPart.value[0] : "";
          needsGrouping = RegExpPrototypeTest(regexIdentifierPart, code);
        } else {
          needsGrouping = !nextPart.hasCustomName();
        }
      }

      if (!needsGrouping && !part.prefix.length && lastPart && lastPart.type === PartType.kFixed) {
        const code = lastPart.value[lastPart.value.length - 1];
        needsGrouping = StringPrototypeIndexOf(options.prefixes, code) !== -1;
      }

      if (needsGrouping) {
        result += "{";
      }

      result += escapePatternString(part.prefix);

      if (customName) {
        result += `:${part.name}`;
      }

      if (part.type === PartType.kRegex) {
        result += `(${part.value})`;
      } else if (part.type === PartType.kSegmentWildcard) {
        if (!customName) {
          result += `(${segmentWildcardRegex})`;
        }
      } else if (part.type === PartType.kFullWildcard) {
        if (
          !customName && (!lastPart || lastPart.type === PartType.kFixed || lastPart.modifier !== Modifier.kNone ||
            needsGrouping || part.prefix !== "")
        ) {
          result += "*";
        } else {
          result += `(${kFullWildcardRegex})`;
        }
      }

      if (part.type === PartType.kSegmentWildcard && customName && !!part.suffix.length) {
        if (RegExpPrototypeTest(regexIdentifierPart, part.suffix[0])) {
          result += "\\";
        }
      }

      result += escapePatternString(part.suffix);

      if (needsGrouping) {
        result += "}";
      }

      if (part.modifier !== Modifier.kNone) {
        result += modifierToString(part.modifier);
      }
    }

    return result;
  }

  class URLPattern {
    #pattern;
    #regexp = {};
    #names = {};
    #component_pattern = {};
    #parts = {};
    #hasRegExpGroups = false;

    constructor(input = {}, baseURLOrOptions = undefined, maybeOptions = undefined) {
      this[webidl.brand] = webidl.brand;
      const prefix = "Failed to construct 'URLPattern'";

      let baseURL;
      let options;
      if (typeof baseURLOrOptions === "string") {
        webidl.requiredArguments(arguments.length, 1, prefix);
        input = webidl.converters.URLPatternInput(input, prefix, "Argument 1");
        baseURL = webidl.converters.USVString(baseURLOrOptions, prefix, "Argument 2");
        options = webidl.converters.URLPatternOptions(
          maybeOptions !== undefined ? maybeOptions : { __proto__: null },
          prefix,
          "Argument 3",
        );
      } else {
        if (input !== undefined) {
          input = webidl.converters.URLPatternInput(input, prefix, "Argument 1");
        } else {
          input = { __proto__: null };
        }
        options = webidl.converters.URLPatternOptions(baseURLOrOptions, prefix, "Argument 2");
      }

      try {
        let baseURLLocal;
        if (typeof baseURL === "string") {
          baseURLLocal = baseURL;
        } else {
          options = baseURLOrOptions;
        }

        if (typeof input === "string") {
          const parser = new Parser(input);
          parser.parse();
          input = parser.result;
          if (baseURLLocal === undefined && typeof input.protocol !== "string") {
            throw new TypeError("A base URL must be provided for a relative constructor string.");
          }
          input.baseURL = baseURLLocal;
        } else {
          if (!input || typeof input !== "object") {
            throw new TypeError("parameter 1 is not of type 'string' and cannot convert to dictionary.");
          }
          if (baseURLLocal) {
            throw new TypeError("parameter 1 is not of type 'string'.");
          }
        }

        if (typeof options === "undefined") {
          options = { ignoreCase: false };
        }

        const ignoreCaseOptions = { ignoreCase: options.ignoreCase === true };

        const defaults = {
          pathname: DEFAULT_PATTERN,
          protocol: DEFAULT_PATTERN,
          username: DEFAULT_PATTERN,
          password: DEFAULT_PATTERN,
          hostname: DEFAULT_PATTERN,
          port: DEFAULT_PATTERN,
          search: DEFAULT_PATTERN,
          hash: DEFAULT_PATTERN,
        };

        this.#pattern = applyInit(defaults, input, true);

        if (defaultPortForProtocol(this.#pattern.protocol) === this.#pattern.port) {
          this.#pattern.port = "";
        }

        for (const component of COMPONENTS) {
          if (!(component in this.#pattern)) continue;
          const opts = {};
          const pattern = this.#pattern[component];
          this.#names[component] = [];
          switch (component) {
            case "protocol":
              ObjectAssign(opts, DEFAULT_OPTIONS);
              opts.encodePart = protocolEncodeCallback;
              break;
            case "username":
              ObjectAssign(opts, DEFAULT_OPTIONS);
              opts.encodePart = usernameEncodeCallback;
              break;
            case "password":
              ObjectAssign(opts, DEFAULT_OPTIONS);
              opts.encodePart = passwordEncodeCallback;
              break;
            case "hostname":
              ObjectAssign(opts, HOSTNAME_OPTIONS);
              if (treatAsIPv6Hostname(pattern)) {
                opts.encodePart = ipv6HostnameEncodeCallback;
              } else {
                opts.encodePart = hostnameEncodeCallback;
              }
              break;
            case "port":
              ObjectAssign(opts, DEFAULT_OPTIONS);
              opts.encodePart = portEncodeCallback;
              break;
            case "pathname":
              if (isSpecialScheme(this.#regexp.protocol)) {
                ObjectAssign(opts, PATHNAME_OPTIONS, ignoreCaseOptions);
                opts.encodePart = standardURLPathnameEncodeCallback;
              } else {
                ObjectAssign(opts, DEFAULT_OPTIONS, ignoreCaseOptions);
                opts.encodePart = pathURLPathnameEncodeCallback;
              }
              break;
            case "search":
              ObjectAssign(opts, DEFAULT_OPTIONS, ignoreCaseOptions);
              opts.encodePart = searchEncodeCallback;
              break;
            case "hash":
              ObjectAssign(opts, DEFAULT_OPTIONS, ignoreCaseOptions);
              opts.encodePart = hashEncodeCallback;
              break;
          }
          try {
            this.#parts[component] = parse(pattern, opts);
            this.#regexp[component] = partsToRegexp(this.#parts[component], this.#names[component], opts);
            this.#component_pattern[component] = partsToPattern(this.#parts[component], opts);
            this.#hasRegExpGroups = this.#hasRegExpGroups ||
              ArrayPrototypeSome(this.#parts[component], (p) => p.type === PartType.kRegex);
          } catch (err) {
            throw new TypeError(`invalid ${component} pattern '${this.#pattern[component]}'.`);
          }
        }
      } catch (err) {
        throw new TypeError(`Failed to construct 'URLPattern': ${err.message}`);
      }
    }

    test(input, baseURL = undefined) {
      webidl.assertBranded(this, URLPatternPrototype);
      const prefix = "Failed to execute 'test' on 'URLPattern'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      input = webidl.converters.URLPatternInput(input, prefix, "Argument 1");
      if (baseURL !== undefined) {
        baseURL = webidl.converters.USVString(baseURL, prefix, "Argument 2");
      }

      let values = {
        pathname: "",
        protocol: "",
        username: "",
        password: "",
        hostname: "",
        port: "",
        search: "",
        hash: "",
      };

      if (typeof input !== "string" && baseURL) {
        throw new TypeError("parameter 1 is not of type 'string'.");
      }

      if (typeof input === "undefined") {
        return false;
      }

      try {
        if (typeof input === "object") {
          values = applyInit(values, input, false);
        } else {
          values = applyInit(values, extractValues(input, baseURL), false);
        }
      } catch {
        return false;
      }

      for (const component of COMPONENTS) {
        if (!RegExpPrototypeExec(this.#regexp[component], values[component])) {
          return false;
        }
      }

      return true;
    }

    exec(input, baseURL = undefined) {
      webidl.assertBranded(this, URLPatternPrototype);
      const prefix = "Failed to execute 'exec' on 'URLPattern'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      input = webidl.converters.URLPatternInput(input, prefix, "Argument 1");
      if (baseURL !== undefined) {
        baseURL = webidl.converters.USVString(baseURL, prefix, "Argument 2");
      }

      let values = {
        pathname: "",
        protocol: "",
        username: "",
        password: "",
        hostname: "",
        port: "",
        search: "",
        hash: "",
      };

      if (typeof input !== "string" && baseURL) {
        throw new TypeError("parameter 1 is not of type 'string'.");
      }

      if (typeof input === "undefined") {
        return null;
      }

      try {
        if (typeof input === "object") {
          values = applyInit(values, input, false);
        } else {
          values = applyInit(values, extractValues(input, baseURL), false);
        }
      } catch {
        return null;
      }

      const result = {};
      result.inputs = baseURL ? [input, baseURL] : [input];

      for (const component of COMPONENTS) {
        const match = RegExpPrototypeExec(this.#regexp[component], values[component]);
        if (!match) {
          return null;
        }

        const groups = {};
        for (const [i, name] of ArrayPrototypeEntries(this.#names[component])) {
          if (typeof name === "string" || typeof name === "number") {
            groups[name] = match[i + 1];
          }
        }

        result[component] = {
          input: values[component] ?? "",
          groups,
        };
      }

      return result;
    }

    static compareComponent(component, left, right) {
      const comparePart = (leftPart, rightPart) => {
        for (const attr of ["type", "modifier", "prefix", "value", "suffix"]) {
          if (leftPart[attr] < rightPart[attr]) return -1;
          if (leftPart[attr] === rightPart[attr]) continue;
          return 1;
        }
        return 0;
      };

      const emptyFixedPart = new Part(PartType.kFixed, "", "", "", "", Modifier.kNone);
      const wildcardOnlyPart = new Part(PartType.kFullWildcard, "", "", "", "", Modifier.kNone);

      const comparePartList = (leftList, rightList) => {
        let i = 0;
        for (; i < MathMin(leftList.length, rightList.length); ++i) {
          const res = comparePart(leftList[i], rightList[i]);
          if (res) return res;
        }

        if (leftList.length === rightList.length) {
          return 0;
        }

        return comparePart(leftList[i] ?? emptyFixedPart, rightList[i] ?? emptyFixedPart);
      };

      if (!left.#component_pattern[component] && !right.#component_pattern[component]) {
        return 0;
      }
      if (left.#component_pattern[component] && !right.#component_pattern[component]) {
        return comparePartList(left.#parts[component], [wildcardOnlyPart]);
      }
      if (!left.#component_pattern[component] && right.#component_pattern[component]) {
        return comparePartList([wildcardOnlyPart], right.#parts[component]);
      }
      return comparePartList(left.#parts[component], right.#parts[component]);
    }

    get protocol() {
      webidl.assertBranded(this, URLPatternPrototype);
      return this.#component_pattern.protocol;
    }

    get username() {
      webidl.assertBranded(this, URLPatternPrototype);
      return this.#component_pattern.username;
    }

    get password() {
      webidl.assertBranded(this, URLPatternPrototype);
      return this.#component_pattern.password;
    }

    get hostname() {
      webidl.assertBranded(this, URLPatternPrototype);
      return this.#component_pattern.hostname;
    }

    get port() {
      webidl.assertBranded(this, URLPatternPrototype);
      return this.#component_pattern.port;
    }

    get pathname() {
      webidl.assertBranded(this, URLPatternPrototype);
      return this.#component_pattern.pathname;
    }

    get search() {
      webidl.assertBranded(this, URLPatternPrototype);
      return this.#component_pattern.search;
    }

    get hash() {
      webidl.assertBranded(this, URLPatternPrototype);
      return this.#component_pattern.hash;
    }

    get hasRegExpGroups() {
      webidl.assertBranded(this, URLPatternPrototype);
      return this.#hasRegExpGroups;
    }
  }

  const URLPatternPrototype = URLPattern.prototype;
  ObjectDefineProperty(URLPatternPrototype, SymbolToStringTag, {
    __proto__: null,
    value: "URLPattern",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // WebIDL converters used by the constructor and methods.
  webidl.converters.URLPatternInit = webidl.createDictionaryConverter(
    "URLPatternInit",
    [
      { key: "protocol", converter: webidl.converters.USVString },
      { key: "username", converter: webidl.converters.USVString },
      { key: "password", converter: webidl.converters.USVString },
      { key: "hostname", converter: webidl.converters.USVString },
      { key: "port", converter: webidl.converters.USVString },
      { key: "pathname", converter: webidl.converters.USVString },
      { key: "search", converter: webidl.converters.USVString },
      { key: "hash", converter: webidl.converters.USVString },
      { key: "baseURL", converter: webidl.converters.USVString },
    ],
  );

  webidl.converters["URLPatternInput"] = (V, prefix, context, opts) => {
    if (typeof V === "object") {
      return webidl.converters.URLPatternInit(V, prefix, context, opts);
    }
    return webidl.converters.USVString(V, prefix, context, opts);
  };

  webidl.converters.URLPatternOptions = webidl.createDictionaryConverter(
    "URLPatternOptions",
    [
      {
        key: "ignoreCase",
        converter: webidl.converters.boolean,
        defaultValue: false,
      },
    ],
  );

  ObjectDefineProperty(globalThis, "URLPattern", {
    __proto__: null,
    value: URLPattern,
    writable: true,
    configurable: true,
    enumerable: false,
  });
})(globalThis);
