/*global System*/
import { parse, nodes } from "lively.ast";
var { funcCall, member, literal } = nodes;
import { evalCodeTransform, evalCodeTransformOfSystemRegisterSetters } from "lively.vm";
import { arr, string, properties, classHelper } from "lively.lang";
import module, { detectModuleFormat } from "./module.js";
import {
  install as installHook,
  remove as removeHook,
  isInstalled as isHookInstalled
} from "./hooks.js";

var isNode = System.get("@system-env").node;

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// helpers
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

function canonicalURL(url) {
  // removes double slashes, doesn't resolve relative parts yet
  var m = url.match(/([^:]+:\/\/)(.*)/);
  if (m) {
    var protocol = m[1];
    url = m[2];
  }
  url = url.replace(/([^:])\/[\/]+/g, "$1/");
  return (protocol || "") + url;
}


// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// module cache experiment
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

export class ModuleTranslationCache {
  static get earliestDate() {
    return +(new Date("Sun Nov 06 2016 16:00:00 GMT-0800 (PST)"))
  }

  cacheModuleSource(moduleId, hash, source) { throw new Error("not yet implemented"); }
  fetchStoredModuleSource(moduleId) { throw new Error("not yet implemented"); }
}

export class NodeModuleTranslationCache extends ModuleTranslationCache {

  async fetchStoredModuleSource(moduleId) {

  }
}

export class BrowserModuleTranslationCache extends ModuleTranslationCache {

  constructor(dbName = "lively.modules-module-translation-cache") {
    super();
    this.version = 1;
    this.sourceCodeCacheStoreName = "sourceCodeStore";
    this.dbName = dbName;
    this.db = this.openDb()
  }

  openDb() {
    var req = System.global.indexedDB.open(this.version);
    return new Promise((resolve, reject) => {
      req.onsuccess = function(evt) { resolve(this.result); };
      req.onerror = evt => reject(evt.target);
      req.onupgradeneeded = (evt) =>
        evt.currentTarget.result.createObjectStore(this.sourceCodeCacheStoreName, {keyPath: 'moduleId'});
    });
  }

  deleteDb() {
    var req = System.global.indexedDB.deleteDatabase(this.dbName);
    return new Promise((resolve, reject) => {
      req.onerror = evt => reject(evt.target);
      req.onsuccess = evt => resolve(evt);
    });
  }

  async closeDb() {
    var db = await this.db;
    var req = db.close();
    return new Promise((resolve, reject) => {
      req.onsuccess = function(evt) { resolve(this.result); };
      req.onerror = evt => reject(evt.target.errorCode);
    })
  }

  async cacheModuleSource(moduleId, hash, source) {
    var db = await this.db;
    return new Promise((resolve, reject) => {
      var transaction = db.transaction([this.sourceCodeCacheStoreName], "readwrite"),
          store = transaction.objectStore(this.sourceCodeCacheStoreName),
          timestamp = Date.now();
      store.put({moduleId, hash, source, timestamp});
      transaction.oncomplete = resolve;
      transaction.onerror = reject;
    });
  }

  async fetchStoredModuleSource(moduleId) {
    var db = await this.db;
    return new Promise((resolve, reject) => {
    var transaction = db.transaction([this.sourceCodeCacheStoreName]),
        objectStore = transaction.objectStore(this.sourceCodeCacheStoreName),
        req = objectStore.get(moduleId);
      req.onerror = reject;
      req.onsuccess = evt => resolve(req.result)
    });
  }
}

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// code instrumentation
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

var node_modulesDir = System.decanonicalize("lively.modules/node_modules/");

var exceptions = [
      // id => id.indexOf(resolve("node_modules/")) > -1,
      // id => canonicalURL(id).indexOf(node_modulesDir) > -1,
      id => !id.endsWith(".js"),
      id => id.endsWith("dist/acorn.js") || id.endsWith("dist/escodegen.browser.js") || id.endsWith("bowser.js"),
      id => id.endsWith("babel-core/browser.js") || id.endsWith("system.src.js") || id.includes("systemjs-plugin-babel"),
    ],
    pendingConfigs = [], configInitialized = false;

function getExceptions() { return exceptions; }
function setExceptions(v) { return exceptions = v; }

function prepareCodeForCustomCompile(System, source, moduleId, env, module, debug) {
  source = String(source);

  var embedOriginalCode = true,
      sourceAccessorName = embedOriginalCode ? env.sourceAccessorName : undefined;

  var options = {
        topLevelVarRecorder: env.recorder,
        varRecorderName: env.recorderName,
        sourceAccessorName: env.sourceAccessorName,
        dontTransform: env.dontTransform,
        recordGlobals: true,
        keepPreviouslyDeclaredValues: true,
        declarationWrapperName: module.varDefinitionCallbackName,
        evalId: module.nextEvalId(),
        currentModuleAccessor: funcCall(
                                member(
                                  funcCall(member("System", "get"), literal("@lively-env")),
                                  "moduleEnv"),
                                literal(moduleId))

      },
      isGlobal = env.recorderName === "System.global",
      header = (debug ? `console.log("[lively.modules] executing module ${moduleId}");\n` : ""),
      footer = "";

  if (isGlobal) {
    // FIXME how to update exports in that case?
    delete options.declarationWrapperName;
  } else {
    header += `System.get("@lively-env").evaluationStart("${moduleId}");\n`
            + `var ${env.recorderName} = System.get("@lively-env").moduleEnv("${moduleId}").recorder;\n`
            + (embedOriginalCode ? `\nvar ${sourceAccessorName} = ${JSON.stringify(source)};\n` : "");
    footer += `\nSystem.get("@lively-env").evaluationEnd("${moduleId}");`
  }

  try {
    var rewrittenSource = header + evalCodeTransform(source, options) + footer;
    if (debug && typeof $morph !== "undefined" && $morph("log")) $morph("log").textString = rewrittenSource;
    return {source: rewrittenSource, options};
  } catch (e) {
    console.error(`Error in prepareCodeForCustomCompile of ${moduleId} ${e.stack}`);
    return {source, options};
  }
}

function prepareTranslatedCodeForSetterCapture(System, source, moduleId, env, module, options, debug) {
  source = String(source);
  var tfmOptions = {
        ...options,
        topLevelVarRecorder: env.recorder,
        varRecorderName: env.recorderName,
        dontTransform: env.dontTransform,
        recordGlobals: true,
        declarationWrapperName: module.varDefinitionCallbackName,
        currentModuleAccessor: funcCall(
                                member(
                                  funcCall(member("System", "get"), literal("@lively-env")),
                                  "moduleEnv"),
                                literal(moduleId))
      },
      isGlobal = env.recorderName === "System.global";

  try {
    var rewrittenSource = evalCodeTransformOfSystemRegisterSetters(source, tfmOptions);
    if (debug && typeof $morph !== "undefined" && $morph("log")) $morph("log").textString += rewrittenSource;
    return rewrittenSource;
  } catch (e) {
    console.error("Error in prepareTranslatedCodeForSetterCapture", e.stack);
    return source;
  }
}

function getCachedNodejsModule(System, load) {
  // On nodejs we might run alongside normal node modules. To not load those
  // twice we have this little hack...
  try {
    var Module = System._nodeRequire("module").Module,
        id = Module._resolveFilename(load.name.replace(/^file:\/\//, "")),
        nodeModule = Module._cache[id];
    return nodeModule;
  } catch (e) {
    System.debug && console.log("[lively.modules getCachedNodejsModule] %s unknown to nodejs", load.name);
  }
  return null;
}

function addNodejsWrapperSource(System, load) {
  // On nodejs we might run alongside normal node modules. To not load those
  // twice we have this little hack...
  var m = getCachedNodejsModule(System, load);
  if (m) {
    load.metadata.format = 'esm';
    load.source = `var exports = System._nodeRequire('${m.id}'); export default exports;\n`
                + properties.allOwnPropertiesOrFunctions(m.exports).map(k =>
                    classHelper.isValidIdentifier(k) ?
                      `export var ${k} = exports['${k}'];` :
                      `/*ignoring export "${k}" b/c it is not a valid identifier*/`).join("\n");
    System.debug && console.log("[lively.modules customTranslate] loading %s from nodejs module cache", load.name);
    return true;
  }
  System.debug && console.log("[lively.modules customTranslate] %s not yet in nodejs module cache", load.name);
  return false;
}

async function customTranslate(proceed, load) {
  // load like
  // {
  //   address: "file:///Users/robert/Lively/lively-dev/lively.vm/tests/test-resources/some-es6-module.js",
  //   name: "file:///Users/robert/Lively/lively-dev/lively.vm/tests/test-resources/some-es6-module.js",
  //   metadata: { deps: [/*...*/], entry: {/*...*/}, format: "esm", sourceMap: ... },
  //   source: "..."
  // }

  var System = this, debug = System.debug;

  if (exceptions.some(exc => exc(load.name))) {
    debug && console.log("[lively.modules customTranslate ignoring] %s", load.name);
    return proceed(load);
  }

  if (isNode && addNodejsWrapperSource(System, load)) {
    debug && console.log("[lively.modules] loaded %s from nodejs cache", load.name)
    return proceed(load);
  }

  var start = Date.now();

  var format = detectModuleFormat(load.source, load.metadata),
      mod = module(System, load.name),
      env = mod.env(),
      instrumented = false,
      isEsm = format === "esm",
      isCjs = format === "cjs",
      isGlobal = format === "global";

  mod.setSource(load.source);

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // cache experiment part 1
  try {
    var useCache = System.useModuleTranslationCache,
        indexdb = System.global.indexedDB,
        hashForCache = useCache && String(string.hashCode(load.source));
    if (useCache && indexdb && isEsm) {
      var cache = System._livelyModulesTranslationCache
               || (System._livelyModulesTranslationCache = new BrowserModuleTranslationCache()),
          stored = await cache.fetchStoredModuleSource(load.name);
      if (stored && stored.hash == hashForCache && stored.timestamp >= BrowserModuleTranslationCache.earliestDate) {
        if (stored.source) {
          load.metadata.format = "register";
          load.metadata.deps = []; // the real deps will be populated when the
                                   // system register code is run, still need
                                   // to define it here to avoid an
                                   // undefined entry later!

          console.log("[lively.modules customTranslate] loaded %s from cache after %sms", load.name, Date.now()-start);
          return Promise.resolve(stored.source);
        }
      }
    }
  } catch (e) {
    console.error(`[lively.modules customTranslate] error reading module translation cache: ${e.stack}`);
  }
  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  var options = {};

  if (isEsm) {
    load.metadata.format = "esm";
    var {options, source} = prepareCodeForCustomCompile(System, load.source, load.name, env, mod, debug);
    load.source = source;
    load.metadata["lively.modules instrumented"] = true;
    instrumented = true;
    debug && console.log("[lively.modules] loaded %s as es6 module", load.name)
    // debug && console.log(load.source)

  } else if (load.metadata.format === "global") {
    env.recorderName = "System.global";
    env.recorder = System.global;
    load.metadata.format = "global";
    var {options, source} = prepareCodeForCustomCompile(System, load.source, load.name, env, mod, debug);
    load.source = source
    load.metadata["lively.modules instrumented"] = true;
    instrumented = true;
    debug && console.log("[lively.modules] loaded %s as instrumented global module", load.name)
  }

  // cjs is currently not supported to be instrumented
  // } else if (isCjs && isNode) {
  //   load.metadata.format = "cjs";
  //   var id = cjs.resolve(load.address.replace(/^file:\/\//, ""));
  //   load.source = cjs._prepareCodeForCustomCompile(load.source, id, cjs.envFor(id), debug);
  //   load.metadata["lively.modules instrumented"] = true;
  //   instrumented = true;
  //   debug && console.log("[lively.modules] loaded %s as instrumented cjs module", load.name)
  //   // console.log("[lively.modules] no rewrite for cjs module", load.name)
  // }

  if (!instrumented) {
    debug && console.log("[lively.modules] customTranslate ignoring %s b/c don't know how to handle format %s", load.name, load.metadata.format);
  }

  return proceed(load).then(async translated => {
    if (translated.indexOf("System.register(") === 0) {
      debug && console.log("[lively.modules customTranslate] Installing System.register setter captures for %s", load.name);
      translated = prepareTranslatedCodeForSetterCapture(System, translated, load.name, env, mod, options, debug);
    }

    // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
    // cache experiment part 2
    if (useCache && indexdb && isEsm) {
      var cache = System._livelyModulesTranslationCache
               || (System._livelyModulesTranslationCache = new BrowserModuleTranslationCache());
      try {
        await cache.cacheModuleSource(load.name, hashForCache, translated)
        console.log("[lively.modules customTranslate] stored cached version for %s", load.name);
      } catch (e) {
        console.error(`[lively.modules customTranslate] failed storing module cache: ${e.stack}`);
      }
    }
    // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

    debug && console.log("[lively.modules customTranslate] done %s after %sms", load.name, Date.now()-start);
    return translated;
  });
}


// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// Functions below are for re-loading modules from change.js. We typically
// start with a load object that skips the normalize / fetch step. Since we need
// to jumo in the "middle" of the load process and SystemJS does not provide an
// interface to this, we need to invoke the translate / instantiate / execute
// manually
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

function instrumentSourceOfEsmModuleLoad(System, load) {
  // brittle!
  // The result of System.translate is source code for a call to
  // System.register that can't be run standalone. We parse the necessary
  // details from it that we will use to re-define the module
  // (dependencies, setters, execute)
  // Note: this only works for esm modules!

  return System.translate(load).then(translated => {
    // translated looks like
    // (function(__moduleName){System.register(["./some-es6-module.js", ...], function (_export) {
    //   "use strict";
    //   var x, z, y;
    //   return {
    //     setters: [function (_someEs6ModuleJs) { ... }],
    //     execute: function () {...}
    //   };
    // });

    var parsed            = parse(translated),
        registerCall      = parsed.body[0].expression,
        depNames          = arr.pluck(registerCall["arguments"][0].elements, "value"),
        declareFuncNode   = registerCall["arguments"][1],
        declareFuncSource = translated.slice(declareFuncNode.start, declareFuncNode.end),
        declare           = eval(`var __moduleName = "${load.name}";(${declareFuncSource});\n//# sourceURL=${load.name}\n`);

    if (System.debug && typeof $morph !== "undefined" && $morph("log"))
      $morph("log").textString = declare;

    return {localDeps: depNames, declare: declare};
  });
}

function instrumentSourceOfGlobalModuleLoad(System, load) {
  // return {localDeps: depNames, declare: declare};
  return System.translate(load).then(translated => ({translated}));
}

function wrapModuleLoad(System) {
  if (isHookInstalled(System, "translate", "lively_modules_translate_hook")) return;
  installHook(
    System, "translate",
    function lively_modules_translate_hook(proceed, load) { return customTranslate.call(System, proceed, load); });
}

function unwrapModuleLoad(System) {
  removeHook(System, "translate", "lively_modules_translate_hook");
}

export {
  wrapModuleLoad, unwrapModuleLoad,
  getExceptions, setExceptions,
  instrumentSourceOfEsmModuleLoad, instrumentSourceOfGlobalModuleLoad
}
