// Copyright 2018-2026 the Limun authors. MIT license.

// Shared Infra Standard helpers. Ports Deno's `ext/web/00_infra.js` to
// Limun's JS-on-ops model:
//   - `__bootstrap`    → `globalThis.__bootstrap`
//   - `core.ops`       → `globalThis.__limunOps` (base64 bytes op added below)
//   - Base64 helpers   → implemented with the existing `btoa`/`atob` globals
//     installed by `ext:limun/05_base64.js`.

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const {
    ArrayPrototypeJoin,
    ArrayPrototypeMap,
    ArrayPrototypeReduce,
    Error,
    JSONStringify,
    NumberPrototypeToString,
    ObjectHasOwn,
    RegExpPrototypeTest,
    SafeRegExp,
    String,
    StringPrototypeCharAt,
    StringPrototypeCharCodeAt,
    StringPrototypeMatch,
    StringPrototypePadStart,
    StringPrototypeReplace,
    StringPrototypeReplaceAll,
    StringPrototypeSlice,
    StringPrototypeSubstring,
    StringPrototypeToLowerCase,
    StringPrototypeToUpperCase,
    TypeError,
  } = primordials;

  const ASCII_DIGIT = ["\u0030-\u0039"];
  const ASCII_UPPER_ALPHA = ["\u0041-\u005A"];
  const ASCII_LOWER_ALPHA = ["\u0061-\u007A"];
  const ASCII_ALPHA = [...ASCII_UPPER_ALPHA, ...ASCII_LOWER_ALPHA];
  const ASCII_ALPHANUMERIC = [...ASCII_DIGIT, ...ASCII_ALPHA];

  const HTTP_TAB_OR_SPACE = ["\u0009", "\u0020"];
  const HTTP_WHITESPACE = [
    "\u000A",
    "\u000D",
    ...HTTP_TAB_OR_SPACE,
  ];

  const HTTP_TOKEN_CODE_POINT = [
    "\u0021",
    "\u0023",
    "\u0024",
    "\u0025",
    "\u0026",
    "\u0027",
    "\u002A",
    "\u002B",
    "\u002D",
    "\u002E",
    "\u005E",
    "\u005F",
    "\u0060",
    "\u007C",
    "\u007E",
    ...ASCII_ALPHANUMERIC,
  ];
  const HTTP_TOKEN_CODE_POINT_RE = new SafeRegExp(
    `^[${regexMatcher(HTTP_TOKEN_CODE_POINT)}]+$`,
  );
  const HTTP_QUOTED_STRING_TOKEN_POINT = [
    "\u0009",
    "\u0020-\u007E",
    "\u0080-\u00FF",
  ];
  const HTTP_QUOTED_STRING_TOKEN_POINT_RE = new SafeRegExp(
    `^[${regexMatcher(HTTP_QUOTED_STRING_TOKEN_POINT)}]+$`,
  );
  const HTTP_TAB_OR_SPACE_MATCHER = regexMatcher(HTTP_TAB_OR_SPACE);
  const HTTP_TAB_OR_SPACE_PREFIX_RE = new SafeRegExp(
    `^[${HTTP_TAB_OR_SPACE_MATCHER}]+`,
    "g",
  );
  const HTTP_TAB_OR_SPACE_SUFFIX_RE = new SafeRegExp(
    `[${HTTP_TAB_OR_SPACE_MATCHER}]+$`,
    "g",
  );
  const HTTP_WHITESPACE_MATCHER = regexMatcher(HTTP_WHITESPACE);
  const HTTP_BETWEEN_WHITESPACE = new SafeRegExp(
    `^[${HTTP_WHITESPACE_MATCHER}]*(.*?)[${HTTP_WHITESPACE_MATCHER}]*$`,
  );
  const HTTP_WHITESPACE_PREFIX_RE = new SafeRegExp(
    `^[${HTTP_WHITESPACE_MATCHER}]+`,
    "g",
  );
  const HTTP_WHITESPACE_SUFFIX_RE = new SafeRegExp(
    `[${HTTP_WHITESPACE_MATCHER}]+$`,
    "g",
  );

  function regexMatcher(chars) {
    const matchers = ArrayPrototypeMap(chars, (char) => {
      if (char.length === 1) {
        const a = StringPrototypePadStart(
          NumberPrototypeToString(StringPrototypeCharCodeAt(char, 0), 16),
          4,
          "0",
        );
        return `\\u${a}`;
      } else if (char.length === 3 && char[1] === "-") {
        const a = StringPrototypePadStart(
          NumberPrototypeToString(StringPrototypeCharCodeAt(char, 0), 16),
          4,
          "0",
        );
        const b = StringPrototypePadStart(
          NumberPrototypeToString(StringPrototypeCharCodeAt(char, 2), 16),
          4,
          "0",
        );
        return `\\u${a}-\\u${b}`;
      } else {
        throw new TypeError("unreachable");
      }
    });
    return ArrayPrototypeJoin(matchers, "");
  }

  function collectSequenceOfCodepoints(input, position, condition) {
    const start = position;
    for (
      let c = StringPrototypeCharAt(input, position);
      position < input.length && condition(c);
      c = StringPrototypeCharAt(input, ++position)
    );
    return { result: StringPrototypeSlice(input, start, position), position };
  }

  const LOWERCASE_PATTERN = new SafeRegExp(/[a-z]/g);

  function byteUpperCase(s) {
    return StringPrototypeReplace(
      String(s),
      LOWERCASE_PATTERN,
      function byteUpperCaseReplace(c) {
        return StringPrototypeToUpperCase(c);
      },
    );
  }

  function byteLowerCase(s) {
    return StringPrototypeToLowerCase(s);
  }

  function collectHttpQuotedString(input, position, extractValue) {
    const positionStart = position;
    let value = "";
    if (input[position] !== "\u0022") throw new TypeError('must be "');
    position++;
    while (true) {
      const res = collectSequenceOfCodepoints(
        input,
        position,
        (c) => c !== "\u0022" && c !== "\u005C",
      );
      value += res.result;
      position = res.position;
      if (position >= input.length) break;
      const quoteOrBackslash = input[position];
      position++;
      if (quoteOrBackslash === "\u005C") {
        if (position >= input.length) {
          value += "\u005C";
          break;
        }
        value += input[position];
        position++;
      } else {
        if (quoteOrBackslash !== "\u0022") throw new TypeError('must be "');
        break;
      }
    }
    if (extractValue) return { result: value, position };
    return {
      result: StringPrototypeSubstring(input, positionStart, position + 1),
      position,
    };
  }

  function forgivingBase64Encode(data) {
    let s = "";
    for (let i = 0; i < data.length; ++i) {
      s += String.fromCharCode(data[i]);
    }
    return btoa(s);
  }

  function forgivingBase64EncodeFromBuffer(data, offset, length) {
    let s = "";
    for (let i = 0; i < length; ++i) {
      s += String.fromCharCode(data[offset + i]);
    }
    return btoa(s);
  }

  function forgivingBase64Decode(data) {
    const s = atob(data);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; ++i) {
      bytes[i] = StringPrototypeCharCodeAt(s, i);
    }
    return bytes;
  }

  function isHttpWhitespace(char) {
    switch (char) {
      case "\u0009":
      case "\u000A":
      case "\u000D":
      case "\u0020":
        return true;
      default:
        return false;
    }
  }

  function httpTrim(s) {
    if (!isHttpWhitespace(s[0]) && !isHttpWhitespace(s[s.length - 1])) {
      return s;
    }
    return StringPrototypeMatch(s, HTTP_BETWEEN_WHITESPACE)?.[1] ?? "";
  }

  class AssertionError extends Error {
    constructor(msg) {
      super(msg);
      this.name = "AssertionError";
    }
  }

  function assert(cond, msg = "Assertion failed.") {
    if (!cond) {
      throw new AssertionError(msg);
    }
  }

  function serializeJSValueToJSONString(value) {
    const result = JSONStringify(value);
    if (result === undefined) {
      throw new TypeError("Value is not JSON serializable");
    }
    return result;
  }

  globalThis.__bootstrap.infra = {
    ASCII_ALPHA,
    ASCII_ALPHANUMERIC,
    ASCII_DIGIT,
    ASCII_LOWER_ALPHA,
    ASCII_UPPER_ALPHA,
    assert,
    AssertionError,
    byteLowerCase,
    byteUpperCase,
    collectHttpQuotedString,
    collectSequenceOfCodepoints,
    forgivingBase64Decode,
    forgivingBase64Encode,
    forgivingBase64EncodeFromBuffer,
    HTTP_QUOTED_STRING_TOKEN_POINT,
    HTTP_QUOTED_STRING_TOKEN_POINT_RE,
    HTTP_TAB_OR_SPACE,
    HTTP_TAB_OR_SPACE_PREFIX_RE,
    HTTP_TAB_OR_SPACE_SUFFIX_RE,
    HTTP_TOKEN_CODE_POINT,
    HTTP_TOKEN_CODE_POINT_RE,
    HTTP_WHITESPACE,
    HTTP_WHITESPACE_PREFIX_RE,
    HTTP_WHITESPACE_SUFFIX_RE,
    httpTrim,
    regexMatcher,
    serializeJSValueToJSONString,
  };
})(globalThis);
