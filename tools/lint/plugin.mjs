import kebabCasePaths from "./kebab-case-paths.mjs";
import noBuiltInTryCatch from "./no-built-in-try-catch.mjs";
import noArrayMethodThisArgument from "./rules/no-array-method-this-argument.ts";
import errorMessageGrammar from "./rules/error-message-grammar.ts";
import noEffectDataLoad from "./rules/no-effect-data-load.ts";
import noEffectOnAsyncResult from "./rules/no-effect-on-async-result.ts";
import noHandBuiltProblem from "./rules/no-hand-built-problem.ts";
import noHandRolledRetry from "./rules/no-hand-rolled-retry.ts";
import noKeyedTtlMap from "./rules/no-keyed-ttl-map.ts";
import noMutableModuleState from "./rules/no-mutable-module-state.ts";
import noRawFormSubmit from "./rules/no-raw-form-submit.ts";

/**
 * Enforces explicit Effect error boundaries, kebab-case directories and the capability registry.
 */
export default {
  meta: { name: "workspace" },
  rules: {
    "error-message-grammar": errorMessageGrammar,
    "kebab-case-paths": kebabCasePaths,
    "no-array-method-this-argument": noArrayMethodThisArgument,
    "no-built-in-try-catch": noBuiltInTryCatch,
    "no-effect-data-load": noEffectDataLoad,
    "no-effect-on-async-result": noEffectOnAsyncResult,
    "no-hand-built-problem": noHandBuiltProblem,
    "no-hand-rolled-retry": noHandRolledRetry,
    "no-keyed-ttl-map": noKeyedTtlMap,
    "no-mutable-module-state": noMutableModuleState,
    "no-raw-form-submit": noRawFormSubmit,
  },
};
