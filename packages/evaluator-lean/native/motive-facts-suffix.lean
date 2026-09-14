/-
Motive instrumentation appended to the exact pinned Comparator Main module.
The stock module and executable remain unchanged. This file observes trusted
checker returns; candidate stdout is never parsed as report data.
-/

structure MotiveComparatorFacts where
  format : String := "motive.comparator-facts/0.1"
  outcome : String := "INCONCLUSIVE"
  current_stage : String := "startup"
  rejection_stage : Option String := none
  protected_build : Bool := false
  toolchain_and_export : Bool := false
  exported_terms : Bool := false
  statement_comparison : Bool := false
  transitive_axioms : Bool := false
  kernel_replay : Bool := false
  used_transitive_axioms : Option (Array String) := none
  deriving Lean.ToJson

namespace Comparator

def rejectMotiveFacts (facts : IO.Ref MotiveComparatorFacts) (stage : String) : M α := do
  facts.modify fun value => { value with outcome := "REJECTED", rejection_stage := some stage }
  throw <| IO.userError s!"Trusted Comparator check rejected at {stage}"

def compareWithMotiveFacts (facts : IO.Ref MotiveComparatorFacts) : M Unit := do
  -- This first reporter profile supports the pinned built-in kernel only.
  -- An unsupported external checker configuration fails before any build.
  if !(← getExternalKernels).isEmpty then
    throw <| IO.userError "Motive reporter does not support external kernel configuration"
  let theoremNames ← getTheoremNames
  let definitionNames ← getDefinitionNames
  let legalAxioms ← getLegalAxioms
  let exportTargets := (← builtinTargets) ++ theoremNames ++ legalAxioms
    ++ (← primitiveTargets) ++ definitionNames

  facts.modify fun value => { value with current_stage := "challenge_build" }
  safeLakeBuild (← getChallengeModule)
  facts.modify fun value => { value with current_stage := "challenge_export" }
  let challengeExport ← safeExport (← getChallengeModule) exportTargets

  facts.modify fun value => { value with current_stage := "solution_build" }
  safeLakeBuild (← getSolutionModule)
  facts.modify fun value => { value with protected_build := true, current_stage := "solution_export" }
  let solutionExport ← safeExport (← getSolutionModule) exportTargets
  facts.modify fun value => { value with toolchain_and_export := true, current_stage := "exported_terms" }

  let challenge ← Export.parseStream (← stringStream challengeExport)
  let solution ← Export.parseStream (← stringStream solutionExport)
  facts.modify fun value => { value with exported_terms := true, current_stage := "statement_comparison" }
  match Comparator.compareAt challenge solution (theoremNames ++ legalAxioms) definitionNames (← primitiveTargets) with
  | .error _ => rejectMotiveFacts facts "statement_comparison"
  | .ok _ => pure ()
  facts.modify fun value => { value with statement_comparison := true, current_stage := "transitive_axioms" }
  match Comparator.checkAxioms solution theoremNames definitionNames legalAxioms with
  | .error _ => rejectMotiveFacts facts "transitive_axioms"
  | .ok _ => pure ()

  -- Reuse the pinned dependency traversal after its complete policy check.
  -- A rejected/incomplete traversal leaves the set null. An established empty
  -- array means the checked theorem really used no direct/transitive axioms.
  let (_, visited) ← IO.ofExcept <|
    (Axioms.loop.run { solution, legalAxioms := Std.HashSet.ofArray legalAxioms }).run
      { worklist := theoremNames ++ definitionNames, checked := {} }
  let used : Array String := visited.checked.toArray.filterMap fun (name : Lean.Name) =>
    match (solution.constMap[name]? : Option Lean.ConstantInfo) with
    | some (Lean.ConstantInfo.axiomInfo info) => some info.name.toString
    | _ => none
  let used := used.qsort fun left right => decide (left < right)
  facts.modify fun value => { value with transitive_axioms := true, used_transitive_axioms := some used, current_stage := "kernel_replay" }

  -- Includes the pinned quotient post-check, not merely its earlier log line.
  if let some _ ← runBuiltinKernel solution then
    rejectMotiveFacts facts "kernel_replay"
  facts.modify fun value => { value with kernel_replay := true, current_stage := "complete", outcome := "VERIFIED" }

end Comparator

def main (args : List String) : IO Unit := do
  let [configPath] := args
    | throw <| IO.userError "Expected exactly one trusted Comparator configuration path"
  if (← IO.getEnv "COMPARATOR_LANDRUN") != some "/opt/evaluator/bin/landrun-namespace-wrapper" then
    throw <| IO.userError "Motive reporter requires the fixed namespace supervisor"
  if (← IO.getEnv "COMPARATOR_LEAN4EXPORT") != some "/opt/evaluator/bin/lean4export" then
    throw <| IO.userError "Motive reporter requires the pinned exporter path"
  if (← IO.getEnv "PATH") != some "/opt/evaluator/bin:/opt/lean/bin:/usr/local/bin:/usr/bin:/bin" then
    throw <| IO.userError "Motive reporter requires the fixed executable search path"
  let reportPath := System.FilePath.mk "/work/trusted-reports/report.json"
  -- The trusted launcher creates this parent outside candidate-writable trees.
  -- It admits one reporter command. No report descriptor is open while an
  -- untrusted child or descendant runs; namespace cleanup precedes this write.
  if ← reportPath.pathExists then
    throw <| IO.userError "Motive report already exists"
  let facts ← IO.mkRef ({} : MotiveComparatorFacts)
  let result : Except IO.Error Unit ← try
    let content ← IO.FS.readFile configPath
    let config ← IO.ofExcept <| Lean.FromJson.fromJson? <| ← IO.ofExcept <| Lean.Json.parse content
    Comparator.M.run (Comparator.compareWithMotiveFacts facts) config
    pure (.ok ())
  catch error => pure (.error error)
  IO.FS.writeFile reportPath ((Lean.toJson (← facts.get)).compress ++ "\n")
  match result with
  | .ok _ => pure ()
  | .error error => throw error
