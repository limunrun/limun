Ideas graduate out of here: the unified io/permissions idea is implemented
(see TODO.md's "IDEAS pass"); its worker-scoping parts are parked on the
Worker item in TODO.md's deferred section. Empty until the next idea.

maybe io permissions should be like `boolean | { read?: boolean, write?: boolean, import?: boolean }`. but i mean if you can read it, you can execute it already. so no need to import or execute permission, because i can just eval the read, or use Worker with data url. yeah