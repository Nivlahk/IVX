import { NodeKind, Node, Edge, Graph } from './graph';
import {
  LogicalSegment,
  Grammar, DecisionContext
} from './grammar';

export function isNonSentinel(n: Node): boolean {
  return n.kind !== 'Start' && n.kind !== 'End';
}

export function inDecisionRange(ctx: DecisionContext, seg: LogicalSegment): boolean {
  const baseIndent =
    ctx.branchIndent !== undefined ? ctx.branchIndent : ctx.header.indent;
  return seg.indent >= baseIndent;
}

export function hasEdge(edges: Edge[], from: number, to: number, label?: string): boolean {
  return edges.some(
    (e) =>
      e.from === from &&
      e.to === to &&
      (e.label ?? '') === (label ?? ''),
  );
}

export function appendMeta(node: Node, extra: string): void {
  node.meta = (node.meta ? node.meta + ' ' : '') + extra;
}

export function findPrevSequentialCandidate(nodes: Node[], startNode: Node): Node | null {
  const idx = nodes.findIndex((n) => n.id === startNode.id);
  if (idx <= 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const cand = nodes[i];
    if (!isNonSentinel(cand)) continue;
    return cand;
  }
  return null;
}

export function findLastNonSentinel(nodes: Node[]): Node | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (!isNonSentinel(n)) continue;
    return n;
  }
  return null;
}

export function isLoopOrNextNode(node: Node | null): boolean {
  const meta = node?.meta ?? '';
  return meta.includes('inline-loop') || meta.includes('inline-next');
}

export function findNextConnector(nodes: Node[], node: Node): Node | null {
  let best: Node | null = null;
  for (const cand of nodes) {
    if (cand.kind !== 'Connector') continue;
    if (cand.line <= node.line) continue;
    if (!best || cand.line < best.line) best = cand;
  }
  return best;
}

export class GraphBuilder {
  nodes: Node[] = [];
  edges: Edge[] = [];
  startNode: Node;
  endNodeId: number | null = null;
  nextId = 1;

  lastExecutableNode: Node | null = null;
  lastConnectorLikeNode: Node | null = null;
  pendingNextNodes: Node[] = [];

  constructor() {
    this.startNode = {
      id: 0,
      kind: 'Start',
      line: 0,
      segmentIndex: 0,
      indent: 0,
      text: '',
      meta: 'implicit start',
    };
    this.nodes.push(this.startNode);
  }

  pushEdge(edge: Edge): void {
    if (hasEdge(this.edges, edge.from, edge.to, edge.label)) return;
    this.edges.push(edge);
  }

  makeNode(kind: NodeKind, seg: LogicalSegment, text: string): Node {
    const baseMeta = seg.comment.trim() || '';
    const node: Node = {
      id: this.nextId++,
      kind,
      line: seg.physicalLine,
      segmentIndex: seg.segmentIndex,
      indent: seg.indent,
      text: text.trim(),
      meta: baseMeta || undefined,
    };
    this.nodes.push(node);
    return node;
  }

  finalizeNode(node: Node, gram: Grammar): Node {
    if (gram.linekey.includes('loop') && this.lastConnectorLikeNode !== null) {
      const target = this.lastConnectorLikeNode;
      if (!hasEdge(this.edges, node.id, target.id)) {
        this.pushEdge({ from: node.id, to: target.id });
      }
      appendMeta(node, 'inline-loop');
    }

    if (gram.linekey.includes('next')) {
      this.pendingNextNodes.push(node);
      appendMeta(node, 'inline-next');
    }

    return node;
  }

  wireSequential(to: Node, updateLast = true): void {
    let from: Node | null = this.lastExecutableNode || this.startNode;

    if (from === this.startNode) {
      const startAlreadyHasEdge = this.edges.some((e) => e.from === this.startNode.id);
      if (startAlreadyHasEdge) {
        from = findLastNonSentinel(this.nodes);
        if (!from) return;
      }
    }

    if (isLoopOrNextNode(from)) {
      from = from ? findPrevSequentialCandidate(this.nodes, from) : null;
    }

    if (from && from.kind === 'Decision') {
      from = findPrevSequentialCandidate(this.nodes, from);
    }

    if (to.kind === 'Connector') {
      if (updateLast && !isLoopOrNextNode(to)) {
        this.lastExecutableNode = to;
      }
      return;
    }

    if (from) {
      this.pushEdge({ from: from.id, to: to.id });
    }

    if (updateLast && !isLoopOrNextNode(to)) {
      this.lastExecutableNode = to;
    }
  }

  createImplicitEnd(line: number, segmentIndex: number, meta: string): Node {
    const implicitEnd: Node = {
      id: this.nextId++,
      kind: 'End',
      line,
      segmentIndex,
      indent: 0,
      text: '',
      meta,
    };
    this.nodes.push(implicitEnd);
    this.endNodeId = implicitEnd.id;
    return implicitEnd;
  }

  computeConnectorFanin(connectorNode: Node): void {
    const k = connectorNode.indent;

    let startLine = 0;
    for (let i = connectorNode.line - 1; i >= 0; i--) {
      const boundary = this.nodes.find(
        (n) =>
          n.line === i &&
          n.indent === k &&
          (n.kind === 'Decision' || n.kind === 'Connector'),
      );
      if (boundary) {
        startLine = boundary.line;
        break;
      }
    }

    const faninWindow = this.nodes.filter(
      (n) =>
        n.id !== connectorNode.id &&
        isNonSentinel(n) &&
        n.indent === k &&
        n.line > startLine &&
        n.line <= connectorNode.line,
    );
    const faninIds = new Set(faninWindow.map((n) => n.id));
    const succsInWindow = new Map<number, number[]>();

    for (const e of this.edges) {
      if (!faninIds.has(e.from) || !faninIds.has(e.to)) continue;
      const arr = succsInWindow.get(e.from);
      if (arr) arr.push(e.to);
      else succsInWindow.set(e.from, [e.to]);
    }

    const canReachFeeder = (startId: number, feederIds: Set<number>): boolean => {
      const visited = new Set<number>();
      const stack = [startId];
      while (stack.length) {
        const id = stack.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        if (id !== startId && feederIds.has(id)) return true;
        for (const nxt of succsInWindow.get(id) ?? []) {
          if (!visited.has(nxt)) stack.push(nxt);
        }
      }
      return false;
    };

    const feederIds = new Set<number>(faninIds);
    for (const n of faninWindow) {
      if (!feederIds.has(n.id)) continue;
      if (canReachFeeder(n.id, feederIds)) {
        feederIds.delete(n.id);
      }
    }

    for (const n of faninWindow) {
      if (isLoopOrNextNode(n)) continue;
      if (!feederIds.has(n.id)) continue;
      if (!hasEdge(this.edges, n.id, connectorNode.id)) {
        this.pushEdge({ from: n.id, to: connectorNode.id });
      }
    }

    const connectorHasOut = this.edges.some((e) => e.from === connectorNode.id);
    if (!connectorHasOut) {
      const nextAtIndent = this.nodes.find(
        (n) =>
          n.id !== connectorNode.id &&
          isNonSentinel(n) &&
          n.indent === connectorNode.indent &&
          n.line > connectorNode.line,
      );
      if (nextAtIndent) {
        this.pushEdge({ from: connectorNode.id, to: nextAtIndent.id });
      }
    }
  }
}