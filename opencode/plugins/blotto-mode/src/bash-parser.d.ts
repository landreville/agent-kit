declare module "bash-parser" {
  export interface BpWord { type: "Word" | "AssignmentWord" | "Name"; text: string; expansion?: BpExpansion[] }
  export interface BpExpansion { type: string; command?: string; commandAST?: BpScript; parameter?: string }
  export interface BpRedirect { type: "Redirect"; op: { text: string; type: string }; file: BpWord; numberIo?: { text: string } }
  export interface BpCommand { type: "Command"; name?: BpWord; prefix?: (BpWord | BpRedirect)[]; suffix?: (BpWord | BpRedirect)[] }
  export interface BpPipeline { type: "Pipeline"; commands: BpNode[] }
  export interface BpLogical { type: "LogicalExpression"; op: "and" | "or"; left: BpNode; right: BpNode }
  export interface BpCompound { type: "CompoundList"; commands: BpNode[] }
  export interface BpSubshell { type: "Subshell"; list: BpCompound }
  export interface BpFor { type: "For"; wordlist?: BpWord[]; do: BpCompound }
  export interface BpWhile { type: "While" | "Until"; clause: BpCompound; do: BpCompound }
  export interface BpIf { type: "If"; clause: BpCompound; then: BpCompound; else?: BpCompound | BpIf }
  export interface BpCase { type: "Case"; clause?: BpWord; cases: { pattern?: BpWord[]; body: BpCompound }[] }
  export interface BpFunction { type: "Function"; body: BpCompound }
  export interface BpScript { type: "Script"; commands: BpNode[] }
  export type BpNode = BpCommand | BpPipeline | BpLogical | BpCompound | BpSubshell | BpFor | BpWhile | BpIf | BpCase | BpFunction | BpScript
  export default function parse(source: string, options?: { mode?: "bash" | "posix" }): BpScript
}
