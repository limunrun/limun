# Non-DOM Web API Build Order

A dependency-ordered TODO for a "browser without the DOM" runtime on bare V8.
Each tier depends only on tiers above it — build straight down, one item at a time.

---

## Already in V8 — do NOT reimplement
- [x] `Promise`, microtask queue (engine)
- [x] `ArrayBuffer`, TypedArrays, `DataView`
- [x] `JSON`, `Math`, `Date`
- [x] `WeakRef`, `FinalizationRegistry`
- [x] `WebAssembly`
- [x] `Atomics`, `SharedArrayBuffer`
- [x] `Intl` (if built with ICU)
- [x] `ValueSerializer` primitive (you'll wrap this for `structuredClone`)

---

## Tier 0 — Host substrate (native)
The native base everything else binds to.
- [ ] Event loop / reactor — task queue wired to V8 microtask checkpoint
- [ ] Module loader — ESM resolution, dynamic `import()`, import maps
- [ ] Exception + unhandledrejection / uncaughtexception plumbing
- [ ] Base IO — env vars, file read/write, host HTTP request
- [ ] Async primitives — timer register, monotonic clock

## Tier 1 — Zero-dependency primitives
Need only ECMAScript + Tier 0.
- [ ] `globalThis` / `self` wiring + the global surface
- [ ] `console` — needs stdout/stderr sink; formatting can grow later
- [ ] `queueMicrotask`
- [ ] Timers — `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval`
- [ ] `TextEncoder` / `TextDecoder` — UTF-8 first, more encodings via ICU later
- [ ] `atob` / `btoa`
- [ ] `DOMException` — error type nearly everything downstream throws
- [ ] `performance.now()` + `performance.timeOrigin`
- [ ] `structuredClone` — base version over ValueSerializer (extended in Tier 5)
- [ ] `reportError`
- [ ] `alert` / `prompt` / `confirm` — terminal or dialog per context

## Tier 2 — Event system
The first chokepoint. Almost everything downstream pulls from this — nail semantics early.
- [ ] `Event`, `CustomEvent`
- [ ] `EventTarget`
- [ ] Event subtypes: `MessageEvent`, `CloseEvent`, `ErrorEvent`,
      `ProgressEvent`, `PromiseRejectionEvent`
- [ ] `AbortController` / `AbortSignal` — needs EventTarget
- [ ] `AbortSignal.timeout()` / `AbortSignal.any()` / `AbortSignal.abort()` statics

## Tier 3 — URL
- [ ] `URL` — needs encoding + IDNA/punycode for host parsing
- [ ] `URLSearchParams`
- [ ] `URLPattern` (optional, newer) — needs URL

## Tier 4 — Streams
The second chokepoint. Blobs, fetch bodies, compression all depend on it.
- [ ] `ReadableStream` (+ default and BYOB/byte readers)
- [ ] `WritableStream`
- [ ] `TransformStream`
- [ ] `CountQueuingStrategy` / `ByteLengthQueuingStrategy`
- [ ] `TextEncoderStream` / `TextDecoderStream` — needs TransformStream + encoders

## Tier 5 — Binary data / blobs
- [ ] `Blob` — needs streams (`.stream()`) + TextDecoder (`.text()`)
- [ ] `File` — extends Blob
- [ ] `FileReader` — needs Blob + EventTarget
- [ ] `URL.createObjectURL` / `URL.revokeObjectURL` — blob URLs; needs Blob + URL
- [ ] Extend `structuredClone` — Blob/File serialization + ArrayBuffer transfer

## Tier 6 — Transforms & crypto
- [ ] `CompressionStream` / `DecompressionStream` — need TransformStream
- [ ] `crypto.getRandomValues` (sync)
- [ ] `crypto.randomUUID` (sync)
- [ ] `crypto.subtle` (+ `CryptoKey`) — needs Promise

## Tier 7 — Networking
- [ ] `Headers`
- [ ] `FormData` — needs File/Blob
- [ ] `Request` / `Response` — need Headers, Blob, ReadableStream, URL, AbortSignal, FormData
- [ ] `fetch` — all of the above + host HTTP client
- [ ] `WebSocket` — host sockets + EventTarget
- [ ] `WebSocketStream` (optional, newer) — streams-based WebSocket
- [ ] `EventSource` — fetch + EventTarget
- [ ] `XMLHttpRequest` (legacy; some libs still need it)
- [ ] `navigator.sendBeacon` — fetch/host

## Tier 8 — Messaging & workers
- [ ] `MessageChannel` / `MessagePort` — need structuredClone (transferables) + event loop
- [ ] `Worker` — module loader + MessagePort + structuredClone
- [ ] Worker-scope globals: `WorkerGlobalScope`, `WorkerNavigator`,
      `WorkerLocation`, `importScripts` (classic), `FileReaderSync`
- [ ] `BroadcastChannel` — EventTarget + host broker
- [ ] `navigator.locks` (Web Locks) — needs a host lock manager
- [ ] `SharedWorker` (optional)

## Tier 9 — navigator base + permissions
The device-API gate. Build the Permissions stub before anything it gates.
- [ ] `navigator` base — `userAgent`, `hardwareConcurrency`, `language`/`languages`, `onLine`
- [ ] `navigator.userAgentData` (UA Client Hints) — optional
- [ ] `navigator.deviceMemory` / `navigator.mediaCapabilities` — simple info props (optional)
- [ ] `Permissions` — `navigator.permissions.query`; `PermissionStatus` is an EventTarget
      > Note: file pickers grant access *without* a pre-granted read permission —
      > the user selects the file/dir and the caller gets only that. Same
      > user-gesture-grants pattern applies to clipboard/notification prompts.

## Tier 10 — Storage / filesystem
- [ ] `Storage` — `localStorage` / `sessionStorage` + `StorageEvent` (string KV)
- [ ] `navigator.storage` — `StorageManager` (estimate/persist)
- [ ] FS handles — `FileSystemHandle`, `FileSystemFileHandle`,
      `FileSystemDirectoryHandle`, `FileSystemWritableFileStream`
      (need File/Blob, WritableStream, Permissions, host FS)
- [ ] File pickers — `showOpenFilePicker` / `showSaveFilePicker` / `showDirectoryPicker`
      (FS handles + host picker UI — the permission-granting entry point above)
- [ ] OPFS — `navigator.storage.getDirectory()` (FS handles)
- [ ] `FileSystemSyncAccessHandle` — sync OPFS access, worker-only (needed for sqlite-wasm etc.)
- [ ] `indexedDB` — `IDBFactory`/`IDBDatabase`/`IDBObjectStore`/`IDBTransaction`/
      `IDBCursor`/`IDBIndex`/`IDBKeyRange`/`IDBRequest` — structuredClone + events + host DB
- [ ] Cache API — `caches` / `Cache` / `CacheStorage` (Request/Response + storage)
- [ ] `CookieStore` (optional) — cookie access + events

## Tier 11 — Device / user-facing (all gated by Permissions)
- [ ] `navigator.clipboard` + `ClipboardItem` — Permissions + Blob + host clipboard
- [ ] `Notification` (+ actions) — Permissions + EventTarget + host notifier
- [ ] `navigator.geolocation` — Permissions + host

## Tier 12 — Scheduling / observers / timing
- [ ] `requestIdleCallback` / `cancelIdleCallback` — event-loop idle
- [ ] `scheduler.postTask` / `scheduler.yield` (Prioritized Task Scheduling)
- [ ] Performance user timing — `performance.mark` / `measure` / `clearMarks` / `getEntries*`
- [ ] `PerformanceObserver` + entry types
- [ ] `ReportingObserver` + `Report` — deprecation/intervention/crash reports
- [ ] `PressureObserver` (Compute Pressure) — CPU/thermal pressure; optional
- [ ] `requestAnimationFrame` — only if you have a frame/render clock; else skip

---

## Optional / advanced — build only if the use case demands it
Mostly gated by Permissions; many need substantial host-side support.

### Graphics / compute (non-DOM but render-adjacent)
- [ ] Geometry interfaces — `DOMMatrix`, `DOMPoint`, `DOMRect`, `DOMQuad`
- [ ] `ImageData`, `ImageBitmap`, `createImageBitmap`, `Path2D`
- [ ] `OffscreenCanvas` (+ 2D / bitmaprenderer / WebGL contexts)
- [ ] WebGPU — `navigator.gpu` (compute without a DOM)

### Media / codecs (headless-capable, no DOM needed)
- [ ] WebCodecs — `VideoEncoder`/`VideoDecoder`, `AudioEncoder`/`AudioDecoder`,
      `VideoFrame`, `AudioData`, `EncodedVideoChunk`/`EncodedAudioChunk`, `ImageDecoder`
- [ ] Web Audio — `AudioContext`, `OfflineAudioContext`, `AudioBuffer`,
      `AudioNode` subclasses, `AudioWorklet` (offline rendering works headless)
- [ ] Media Source Extensions — `MediaSource`, `SourceBuffer`, `ManagedMediaSource`
- [ ] `MediaStream` / `MediaStreamTrack` / `MediaRecorder` — device-gated capture

### Service Worker family (skip for pure headless; needed for SW semantics)
- [ ] `ServiceWorker`, `ServiceWorkerRegistration`, `ServiceWorkerContainer`
- [ ] `ServiceWorkerGlobalScope`, `Clients`, `Client`, `WindowClient`
- [ ] `ExtendableEvent`, `FetchEvent`, `InstallEvent`
- [ ] Push API — `PushManager`, `PushSubscription`, `PushMessageData`, `PushEvent`
- [ ] Background Sync (`SyncManager`), Background Fetch, Periodic Background Sync
- [ ] `ContentIndex`, Payment Handler (SW-scoped)

### Advanced networking
- [ ] `WebTransport` (+ datagram / bidirectional streams) — needs HTTP/3 / QUIC
- [ ] `RTCPeerConnection` / `RTCDataChannel` (WebRTC data subset, no media)

### Sensors (Generic Sensor API — all Permissions-gated)
- [ ] `Sensor` base + `Accelerometer`, `Gyroscope`, `Magnetometer`,
      `LinearAccelerationSensor`, `GravitySensor`, `AbsoluteOrientationSensor`,
      `RelativeOrientationSensor`, `AmbientLightSensor`

### Hardware / device access (all Permissions-gated, heavy host support)
- [ ] `navigator.serial` (Web Serial)
- [ ] `navigator.usb` (WebUSB)
- [ ] `navigator.hid` (WebHID)
- [ ] `navigator.bluetooth` (Web Bluetooth)
- [ ] `NDEFReader` (Web NFC)
- [ ] `navigator.getBattery()` (Battery Status)
- [ ] `navigator.vibrate`
- [ ] `navigator.wakeLock` (Screen Wake Lock)
- [ ] `navigator.connection` (Network Information)
- [ ] `IdleDetector` (Idle Detection)
- [ ] `navigator.contacts` (`ContactsManager`)
- [ ] Gamepad API — `getGamepads()` + events

### User-facing / integration (mostly need a UI host)
- [ ] `navigator.share` / `navigator.canShare` (Web Share)
- [ ] `navigator.credentials` (`CredentialsContainer`, `PasswordCredential`,
      `PublicKeyCredential`/WebAuthn, `OTPCredential`)
- [ ] Web Speech — `SpeechSynthesis`, `SpeechRecognition`
- [ ] `HandwritingRecognizer`

---

## Consciously excluded (so the boundary is explicit)
The list above is the full set of **non-DOM API families**, not every MDN entry.
MDN is "not that short" mostly because it also documents all of the following,
which a DOM-less runtime does *not* implement:

- **All DOM** — `document`, `Node`, every `HTML*Element`/`SVG*Element`, `Element`,
  `ShadowRoot`, `Range`, `Selection`, DOM parsing/serialization, `CSSOM`.
- **DOM-bound observers** — `MutationObserver`, `IntersectionObserver`,
  `ResizeObserver` (they observe DOM nodes; `PerformanceObserver`/`ReportingObserver`
  are kept above because they don't).
- **Window/navigation** — `Window`, `History`, `Location`, the Navigation API,
  `visualViewport`, focus/scroll — replaced by worker-scope globals.
- **Sub-interfaces that ship with their parent** — every stream reader/controller
  (`ReadableStreamDefaultReader`, `WritableStreamDefaultController`, …), every
  `IDB*` cursor/range, every event/dictionary/enum. These aren't separate todos.
- **Deprecated / vendor-prefixed** surfaces.

## Getting the truly exhaustive list
If you want the machine-readable source of truth rather than a curated list:
- **`@webref/idl`** (npm) — the reference Web IDL for every published spec.
  Filter out the DOM/HTML/CSS/SVG specs and you have literally every interface.
- **Web Platform Tests** (`web-platform-tests/wpt`) — directory per spec
  (`/streams`, `/fetch`, `/FileAPI`, `/IndexedDB`, …). Each dir is both the
  checklist *and* your conformance suite — implement until the tests pass.

---

## Two things to internalize
1. **EventTarget (Tier 2) and Streams (Tier 4) are the chokepoints.** Nearly
   everything downstream pulls from one or both — get their semantics right first.
2. **Permissions (Tier 9) is the third chokepoint.** Clipboard, notifications,
   geolocation, and FS pickers all query it. A stub that resolves `granted`
   unblocks the whole device layer before the real prompt flow exists.