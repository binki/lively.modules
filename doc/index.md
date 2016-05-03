## main interface



### `lively.modules.importPackage(packageName)`

To load a project into your runtime you will typically use
`lively.modules.importPackage('some-package-name')`. `'some-package-name'`
should resolve to a directory with a JSON package config file (typically
package.json) that at least defines a `name` field. The package will be
imported, i.e. the main module of the package will be loaded via
`lively.modules.System.import('some-package-name/index.js')`. By default the
name of main is `'index.js'` but this can be customized via the `main` field
of the package config file.

The result of the importPackage call is the promise for loading the main module.

#### Specifics of the lively package format

The main purpose of the lively package format is to make it easy to integrate
dependent packages in the lively.module and es6 module systems. It allows you
to define a `"lively"` field in the main JSON that allows to set a separate
main module, a `"packageMap"` object that maps names that can be used in
`import` statements to directories of sub-packages. When sub-packages are
discovered while importing a package, those are recursively imported as well.

Here is an example how a config inside a package.json file could look like.

```json
{
  "name": "some-package",
  "main": "main-for-non-es6.js",
  "lively": {
    "main": "for-es6.js",
    "packageMap": {
      "dep1": "./node_modules/dep1",
      "dep2": "./libs/dep2"
    }
  }
}
```

For more examples, see [lively.modules/package.json](https://github.com/LivelyKernel/lively.modules/package.json), or [lively.ast/package.json](https://github.com/LivelyKernel/lively.ast/package.json).

### `lively.modules.System`

The main lively.modules interface provides access to a System loader object
(currently from the [SystemJS library](https://github.com/systemjs/systemjs)
that has some improvements added, e.g.   the name normalization respects the
lively package conventions, translate is   used to instrument code by
default, etc.

By default the loader instance is the same as the global loader (e.g.
window.System). Note: *The System instance can be easily changed* to support
multiple, isolated environnments.

Example:

```js
var testSystem = lively.modules.getSystem("my-test-system");
lively.modules.changeSystem(testSystem, true); // true: make the System global
System.import("some-module"); // uses the new System loader
```

Now all state (what modules are loaded, their metadata, etc) are stored in
`testSystem`. Changing to another System allows to define different name
resolution approach etc.

Side note: Since all System related implementation functions defined in the
modules in src/ will take a System loader object as first parameter, the
implementation is loader independent.

### Loader state / module state

- `lively.modules.loadedModules()`: Returns a list of ids of the currently loaded modules.

- lively.modules.printSystemConfig(): Returns a stringified version of the [SystemJS config](https://github.com/systemjs/systemjs/blob/master/docs/config-api.md). Useful for debugging SystemJS issues

- `lively.modules.sourceOf(moduleId)`: Returns the original source code of the module identified by `moduleId`.

- `lively.modules.moduleEnv(moduleId)`: Returns the evaluation environment of the module behind `moduleId`. 

A "moduleEnv" is the object used for recording the evaluation state. Each
module that is loaded with source instrumentation enabled as an according
moduleEnv It is populated when the module is imported and then used and
modified when users run evaluations using `runEval()` or change the module's
code with `moduleSourceChange()`. You can get access to the internal module
state via `moduleEnv('some-module').recorder` the recorder is a map of
variable and function names.

Example: When lively.modules is bootstrapped you can access the state of its
main module via:

```js
var id = System.normalizeSync("lively.modules/index.js");
Object.keys(lively.modules.moduleEnv(id).recorder);
  // => ["defaultSystem", "changeSystem", "loadedModules", "sourceOf", "moduleEnv", ...]
lively.modules.moduleEnv(id).recorder.changeSystem
  // => function() {...} The actual object defined in the module scope
```


### instrumentation

By default lively.modules will hook into the `System.translate` process so that source code of modules get transformed to allow recording of their internal evaluation state (that is then captured in `moduleEnv`s). You can enable and disable this behavior via

- `lively.modules.wrapModuleLoad()`
- `lively.modules.unwrapModuleLoad()`

### evaluation

#### `runEval(sourceString, options)`

To evaluate an expression in the context of a module (to access and modify
its internal state) you can use the `runEval` method.

Example: If you have a module `a.js` with the source code

```js
var x = 23;
export x;
```

you can evaluate an expression like `x + 2` via
`lively.modules.runEval("x + 2", {targetModule: "a.js"})`.
This will return a promise that resolves to an `EvalResult` object. The eval
result will have a field `value` which is the actual return value of the last
expression evaluated. In this example it is the number 25.

Note: Since variable `x` is exported by `a.js` the evaluation will also
affect the exported value of the module. Dependent modules will automatically
have access to the new exported value x.

*Caveat in the current version*: When evaluating new exports (exports that
didn't exist when the module was first imported) you need to run
`reloadModule` (see below) to properly update dependent modules!


#### `moduleSourceChange(moduleName, newSource, options)`

To redefine a module's source code at runtime you can use the
moduleSourceChange method. Given `a.js` from the previous example you can run
`lively.modules.moduleSourceChange('a.js', 'var x = 24;\nexport x;')`.
This will a) evaluate the changed code and b) try to modify the actual file
behind the module. In browser environments this is done via a `PUT` request,
in node.js `fs.writeFile` is used.


### module dependencies

#### `lively.modules.findDependentsOf(moduleName)`

Which modules (module ids) are (in)directly import module with id.

Let's say you have

- module1.js: `export var x = 23;`
- module2.js: `import {x} from "module1.js"; export var y = x + 1;`
- module3.js: `import {y} from "module2.js"; export var z = y + 1;`

`findDependentsOf("module1.js")` returns ["module2", "module3"]

#### `findRequirementsOf(moduleName)`

which modules (module ids) are (in)directly required by module with id?

Let's say you have

- module1: `export var x = 23;`
- module2: `import {x} from "module1.js"; export var y = x + 1;`
- module3: `import {y} from "module2.js"; export var z = y + 1;`

`findRequirementsOf("module3")` will report ["module2", "module1"]

#### reloadModule(moduleName, options)

Will re-import the module identified by `moduleName`. By default this will
also reload all direct and indirect dependencies of that module. You can
control that behavior via `options`, the default value of it is
`{reloadDeps: true, resetEnv: true}`.

#### `forgetModule(moduleName, options)`

Will remove the module from the loaded module set of lively.modules.System.
`options` are by default `{forgetDeps: true, forgetEnv: true}`.

#### `requireMap()`

Will return a JS object whose keys are module ids and the corresponding
values are lists of module ids of those modules that dependent on the key
module (including the key module itself). I.e. the importers of that module.


### `importsAndExportsOf(moduleId)`

Returns a promise that resolves to an object with fields `exports` and
`imports`. The values referenced by those fields are lists with objects about
the exact import and export information of variables in that module. For
exports this includes the export AST node, the local name of the exported
variable, its export name, etc. For imports it includes the imported variable
name, the module from where it was imported etc.

Example:

```js
lively.module.importsAndExportsOf("lively.modules/index.js");
  // =>
  // Promise({
  //   exports: [{
  //       exportStatement: {},
  //       exported: "getSystem",
  //       local: "getSystem",
  //       fromModule: "http://localhost:9001/node_modules/lively.modules/index.js",
  //       localModule: "http://localhost:9001/node_modules/lively.modules/index.js"
  //     }, ...],
  //   imports: [{
  //       fromModule: "lively.lang",
  //       importStatement: {...}, // AST node
  //       local: "obj",
  //       localModule: "http://localhost:9001/node_modules/lively.modules/index.js"
  //     }, {
  //       fromModule: "./src/system.js",
  //       importStatement: {...}, // AST node
  //       local: "getSystem",
  //       localModule: "http://localhost:9001/node_modules/lively.modules/index.js"
  //     }, ...]
  //   })
```

### hooks

lively.modules provides an easy way to customize the behavior of the System
loader object via `installHook` and `removeHook`. To extend the behavior of
of `lively.modules.System.fetch` you can for example do

```js
installHook("fetch", function myFetch(proceed, load) {
  if (load.name === "my-custom-module.js") return "my.custom.code()";
  return proceed(load); // default behavior
});
```



<!--*no toc!*-->
