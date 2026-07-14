// Copyright 2018-2026 the Limun authors. MIT license.

// MIME type parsing — WHATWG MIME Sniffing Standard
// (https://mimesniff.spec.whatwg.org/#parsing-a-mime-type).
// Ports Deno's `ext/web/01_mimesniff.js` to Limun's JS-on-ops model.

((globalThis) => {
  const { primordials } = globalThis.__bootstrap;
  const {
    ArrayPrototypeIncludes,
    MapPrototypeGet,
    MapPrototypeHas,
    MapPrototypeSet,
    RegExpPrototypeExec,
    RegExpPrototypeTest,
    SafeMap,
    SafeMapIterator,
    StringPrototypeEndsWith,
    StringPrototypeReplaceAll,
    StringPrototypeToLowerCase,
    TypedArrayPrototypeGetLength,
    TypedArrayPrototypeIncludes,
    Uint8Array,
  } = primordials;

  const {
    assert,
    collectHttpQuotedString,
    collectSequenceOfCodepoints,
    HTTP_QUOTED_STRING_TOKEN_POINT_RE,
    HTTP_TOKEN_CODE_POINT_RE,
    HTTP_WHITESPACE,
    HTTP_WHITESPACE_PREFIX_RE,
    HTTP_WHITESPACE_SUFFIX_RE,
  } = globalThis.__bootstrap.infra;

  function parseMimeType(input) {
    input = StringPrototypeReplaceAll(input, HTTP_WHITESPACE_PREFIX_RE, "");
    input = StringPrototypeReplaceAll(input, HTTP_WHITESPACE_SUFFIX_RE, "");

    let position = 0;
    const endOfInput = input.length;

    const res1 = collectSequenceOfCodepoints(
      input,
      position,
      (c) => c != "\u002F",
    );
    const type = res1.result;
    position = res1.position;

    if (type === "" || !RegExpPrototypeTest(HTTP_TOKEN_CODE_POINT_RE, type)) {
      return null;
    }

    if (position >= endOfInput) return null;

    position++;

    const res2 = collectSequenceOfCodepoints(
      input,
      position,
      (c) => c != "\u003B",
    );
    let subtype = res2.result;
    position = res2.position;

    subtype = StringPrototypeReplaceAll(subtype, HTTP_WHITESPACE_SUFFIX_RE, "");

    if (
      subtype === "" || !RegExpPrototypeTest(HTTP_TOKEN_CODE_POINT_RE, subtype)
    ) {
      return null;
    }

    const mimeType = {
      type: StringPrototypeToLowerCase(type),
      subtype: StringPrototypeToLowerCase(subtype),
      parameters: new SafeMap(),
    };

    while (position < endOfInput) {
      position++;

      const res1 = collectSequenceOfCodepoints(
        input,
        position,
        (c) => ArrayPrototypeIncludes(HTTP_WHITESPACE, c),
      );
      position = res1.position;

      const res2 = collectSequenceOfCodepoints(
        input,
        position,
        (c) => c !== "\u003B" && c !== "\u003D",
      );
      let parameterName = res2.result;
      position = res2.position;

      parameterName = StringPrototypeToLowerCase(parameterName);

      if (position < endOfInput) {
        if (input[position] == "\u003B") continue;
        position++;
      }

      if (position >= endOfInput) break;

      let parameterValue = null;

      if (input[position] === "\u0022") {
        const res = collectHttpQuotedString(input, position, true);
        parameterValue = res.result;
        position = res.position;

        position++;
      } else {
        const res = collectSequenceOfCodepoints(
          input,
          position,
          (c) => c !== "\u003B",
        );
        parameterValue = res.result;
        position = res.position;

        parameterValue = StringPrototypeReplaceAll(
          parameterValue,
          HTTP_WHITESPACE_SUFFIX_RE,
          "",
        );

        if (parameterValue === "") continue;
      }

      if (
        parameterName !== "" &&
        RegExpPrototypeTest(HTTP_TOKEN_CODE_POINT_RE, parameterName) &&
        RegExpPrototypeTest(
          HTTP_QUOTED_STRING_TOKEN_POINT_RE,
          parameterValue,
        ) &&
        !MapPrototypeHas(mimeType.parameters, parameterName)
      ) {
        MapPrototypeSet(mimeType.parameters, parameterName, parameterValue);
      }
    }

    return mimeType;
  }

  function essence(mimeType) {
    return `${mimeType.type}/${mimeType.subtype}`;
  }

  function serializeMimeType(mimeType) {
    let serialization = essence(mimeType);
    for (const param of new SafeMapIterator(mimeType.parameters)) {
      serialization += `;${param[0]}=`;
      let value = param[1];
      if (RegExpPrototypeExec(HTTP_TOKEN_CODE_POINT_RE, value) === null) {
        value = StringPrototypeReplaceAll(value, "\\", "\\\\");
        value = StringPrototypeReplaceAll(value, '"', '\\"');
        value = `"${value}"`;
      }
      serialization += value;
    }
    return serialization;
  }

  function extractMimeType(headerValues) {
    if (headerValues === null) return null;

    let charset = null;
    let essence_ = null;
    let mimeType = null;
    for (let i = 0; i < headerValues.length; ++i) {
      const value = headerValues[i];
      const temporaryMimeType = parseMimeType(value);
      if (
        temporaryMimeType === null ||
        essence(temporaryMimeType) == "*/*"
      ) {
        continue;
      }
      mimeType = temporaryMimeType;
      if (essence(mimeType) !== essence_) {
        charset = null;
        const newCharset = MapPrototypeGet(mimeType.parameters, "charset");
        if (newCharset !== undefined) {
          charset = newCharset;
        }
        essence_ = essence(mimeType);
      } else {
        if (
          !MapPrototypeHas(mimeType.parameters, "charset") &&
          charset !== null
        ) {
          MapPrototypeSet(mimeType.parameters, "charset", charset);
        }
      }
    }
    return mimeType;
  }

  function isXML(mimeType) {
    return StringPrototypeEndsWith(mimeType.subtype, "+xml") ||
      essence(mimeType) === "text/xml" || essence(mimeType) === "application/xml";
  }

  function patternMatchingAlgorithm(input, pattern, mask, ignored) {
    assert(
      TypedArrayPrototypeGetLength(pattern) ===
        TypedArrayPrototypeGetLength(mask),
    );

    if (
      TypedArrayPrototypeGetLength(input) < TypedArrayPrototypeGetLength(pattern)
    ) {
      return false;
    }

    let s = 0;
    for (; s < TypedArrayPrototypeGetLength(input); s++) {
      if (!TypedArrayPrototypeIncludes(ignored, input[s])) {
        break;
      }
    }

    let p = 0;
    for (; p < TypedArrayPrototypeGetLength(pattern); p++, s++) {
      const maskedData = input[s] & mask[p];
      if (maskedData !== pattern[p]) {
        return false;
      }
    }

    return true;
  }

  const ImageTypePatternTable = [
    [
      new Uint8Array([0x00, 0x00, 0x01, 0x00]),
      new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]),
      new Uint8Array(),
      "image/x-icon",
    ],
    [
      new Uint8Array([0x00, 0x00, 0x02, 0x00]),
      new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]),
      new Uint8Array(),
      "image/x-icon",
    ],
    [
      new Uint8Array([0x42, 0x4D]),
      new Uint8Array([0xFF, 0xFF]),
      new Uint8Array(),
      "image/bmp",
    ],
    [
      new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]),
      new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
      new Uint8Array(),
      "image/gif",
    ],
    [
      new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
      new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
      new Uint8Array(),
      "image/gif",
    ],
    [
      new Uint8Array([
        0x52,
        0x49,
        0x46,
        0x46,
        0x00,
        0x00,
        0x00,
        0x00,
        0x57,
        0x45,
        0x42,
        0x50,
        0x56,
        0x50,
      ]),
      new Uint8Array([
        0xFF,
        0xFF,
        0xFF,
        0xFF,
        0x00,
        0x00,
        0x00,
        0x00,
        0xFF,
        0xFF,
        0xFF,
        0xFF,
        0xFF,
        0xFF,
      ]),
      new Uint8Array(),
      "image/webp",
    ],
    [
      new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
      new Uint8Array(),
      "image/png",
    ],
    [
      new Uint8Array([0xFF, 0xD8, 0xFF]),
      new Uint8Array([0xFF, 0xFF, 0xFF]),
      new Uint8Array(),
      "image/jpeg",
    ],
  ];

  function imageTypePatternMatchingAlgorithm(input) {
    for (let i = 0; i < ImageTypePatternTable.length; i++) {
      const row = ImageTypePatternTable[i];
      const patternMatched = patternMatchingAlgorithm(
        input,
        row[0],
        row[1],
        row[2],
      );
      if (patternMatched) {
        return row[3];
      }
    }

    return undefined;
  }

  function sniffImage(mimeTypeString, byteSequence) {
    if (mimeTypeString !== null && isXML(mimeTypeString)) {
      return mimeTypeString;
    }

    const imageTypeMatched = imageTypePatternMatchingAlgorithm(byteSequence);
    if (imageTypeMatched !== undefined) {
      return imageTypeMatched;
    }

    return mimeTypeString;
  }

  globalThis.__bootstrap.mimeType = {
    essence,
    extractMimeType,
    parseMimeType,
    serializeMimeType,
    sniffImage,
  };
})(globalThis);
