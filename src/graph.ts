export type NodeKind =
  | 'Start'
  | 'End'
  | 'Process'
  | 'Decision'
  | 'Connector'
  | 'Input'
  | 'Output';

export interface Node {
  id: number;
  kind: NodeKind;
  line: number;
  segmentIndex: number;
  indent: number;
  text: string;
  meta?: string;
}

export interface Edge {
  from: number;
  to: number;
  label?: string;
}

export interface Graph {
  nodes: Node[];
  edges: Edge[];
  startNodeId: number | null;
  endNodeId: number | null;
  validationErrors?: string[];
}

export const NODE_ARITY_RULES: Record<
  NodeKind,
  { minIn: number; maxIn: number; minOut: number; maxOut: number }
> = {
  Start: { minIn: 0, maxIn: 0, minOut: 1, maxOut: 1 },
  End: { minIn: 1, maxIn: 1, minOut: 0, maxOut: 0 },
  Process: { minIn: 1, maxIn: 1, minOut: 1, maxOut: 1 },
  Decision: { minIn: 1, maxIn: Infinity, minOut: 2, maxOut: Infinity },
  Connector: { minIn: 1, maxIn: Infinity, minOut: 1, maxOut: 1 },
  Input: { minIn: 1, maxIn: 1, minOut: 1, maxOut: 1 },
  Output: { minIn: 1, maxIn: 1, minOut: 1, maxOut: 1 },
};

export function validNodeIO(
  nodes: Node[],
  edges: Edge[],
): string[] {
  const errors: string[] = [];
  const inDegree = new Map<number, number>();
  const outDegree = new Map<number, number>();

  for (const edge of edges) {
    outDegree.set(edge.from, (outDegree.get(edge.from) || 0) + 1);
    inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
  }
  for (const node of nodes) {
    if (node.meta && node.meta.includes('fun-body-of=')) continue;
    const inCount = inDegree.get(node.id) || 0;
    const outCount = outDegree.get(node.id) || 0;
    const rules = NODE_ARITY_RULES[node.kind];
    const nodeInfo = `N${node.id.toString().padStart(3)} [${node.kind}] L${node.line + 1}`;

    if (inCount < rules.minIn)
      errors.push(`${nodeInfo} has ${inCount} inputs (expected ≥${rules.minIn})`);

    if (rules.maxIn !== Infinity && inCount > rules.maxIn)
      errors.push(`${nodeInfo} has ${inCount} inputs (expected ≤${rules.maxIn})`);

    if (outCount < rules.minOut)
      errors.push(`${nodeInfo} has ${outCount} outputs (expected ≥${rules.minOut})`);

    if (rules.maxOut !== Infinity && outCount > rules.maxOut)
      errors.push(`${nodeInfo} has ${outCount} outputs (expected ≤${rules.maxOut})`);
  }
  return errors;
}