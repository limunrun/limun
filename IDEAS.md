i dont see any reason why we have read and net as seperated in permissions, 
all are source urls, one is file: protocol one is https: protocol, not that different.
so instead we can have an io permission. with some pattern, like glob pattern maybe? 
then it can be `boolean | { read?: boolean, write?: boolean }` on each item.

of course this is applied to all of imports, net and fs. because all do io, basically anything that does io, need to follow these permissions, no leaks.
then the import, net, fs permissions can be seperate boolean only permissions that closes or opens the thing complately.

also worker if we define another permission on a worker, it shouldn't inherit root permissions.
basically host permissions still apply to the worker of course. but if i do:
```ts
new Worker(.., { limun: { permissions: {} } })
```
then this worker has no permissions to anything.

also permissions shouldn't to cli prompting, it halts to program forever, until someone enters the terminal and picks something.
its not neccery at all. just follow the permissions in the limun.json file, dont ask for extra permissions just reject.

and if also for workers we can have async callback fucntions or something like that, that lets worker ask host for permission on stuff.
so we can show some ui or something in some apps with isolated plugins. if the callback not defined then dont ask for it.

also access to legacy Node.js compat stuff should also be behind permission, something like `legacy?: boolean`.
this includes things like:
```ts
Limun.legacy.require()
Limun.legacy.fs // fs functions there are hard to wrap in a thin way (used by compat libraries)
```

we never mention Node.js in code, we just call it legacy.