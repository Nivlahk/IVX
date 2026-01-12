import * as vscode from 'vscode';
import {
  inDecisionRange,
  isNonSentinel,
  findPrevSequentialCandidate,
  findNextConnector,
  appendMeta,
  GraphBuilder,
} from './valid';
import { NodeKind, Node, Edge, Graph } from './graph';
import {
  LogicalSegment,
  DecisionContext,
  FunContext,
  Grammar,
  splitDecisionLabels,
  collectSegments,
  SegGram,
  isElseOrThen,
} from './grammar';

const peek = <T>(stack: T[]): T | undefined =>
  stack[stack.length - 1];

export function parseivx(doc: vscode.TextDocument): Graph {
  const segments = collectSegments(doc.getText());
  const gb = new GraphBuilder();
  const nodes = gb.nodes;
  const edges = gb.edges;
  const startNode = gb.startNode;
  const pendingNextNodes = gb.pendingNextNodes;
  let lastNode: Node | null = startNode;
  let endNodeId: number | null = null;
  let currentBranchIndex: number | null = null;
  const decisionStack: DecisionContext[] = [];
  const funStack: FunContext[] = [];

  const inFun = (): FunContext | undefined => peek(funStack);

  const registerInFun = (node: Node) => {
    const topFun = inFun();
    if (!topFun) return;
    const fromId = topFun.lastBodyNodeId ?? topFun.header.id;
    const fromNode = nodes.find((n) => n.id === fromId);
    const meta = fromNode?.meta ?? '';
    const isLoopOrNext =
      meta.includes('inline-loop') || meta.includes('inline-next');

    if (fromNode && !isLoopOrNext) {
      gb.pushEdge({ from: fromId, to: node.id });
    }
    topFun.bodyNodeIds.push(node.id);
    topFun.lastBodyNodeId = node.id;
    appendMeta(node, `fun-body-of=${topFun.header.id}`);
  };
  const createExecutableNode = (
    kind: NodeKind,
    seg: LogicalSegment,
    text: string,
    gram: Grammar,
    opts?: { skipFunRegister?: boolean },
  ): Node => {
    const raw = gb.makeNode(kind, seg, text);
    const node = gb.finalizeNode(raw, gram);
    lastNode = node;
    if (!opts?.skipFunRegister) {
      registerInFun(node);
    }
    return node;
  };
  const currentDecision = (): DecisionContext | null =>
    peek(decisionStack) ?? null;
  const popObsoleteDecisions = (seg: LogicalSegment, speckey?: string | null) => {
    while (decisionStack.length) {
      const top = decisionStack[decisionStack.length - 1];
      const cutoff = top.branchIndent ?? top.header.indent;

      if (seg.indent < cutoff) {
        decisionStack.pop();
        currentBranchIndex = null;
        continue;
      }
      const atDecisionLevel = seg.indent === cutoff;
      const hasSpec = isElseOrThen(speckey);

      if (atDecisionLevel && !hasSpec && top.hasExplicitSpec) {
        decisionStack.pop();
        const tails = Array.from(top.tails.values());
        const lastTail = tails[tails.length - 1];
        gb.lastExecutableNode = lastTail ?? top.header;
        currentBranchIndex = null;
        continue;
      }
      break;
    }
  };
  type AttachResult = {
    branchIndex: number | null;
    lastExecutableNode: Node | null;
  };
  const attachElseNodeToDecision = (ctx: DecisionContext, node: Node): AttachResult => {
    const branchIndex = ctx.branches.length;
    const edge: Edge = { from: ctx.header.id, to: node.id };
    if (ctx.labels && ctx.labels[branchIndex] !== undefined) {
      edge.label = ctx.labels[branchIndex];
    }
    gb.pushEdge(edge);
    ctx.branches[branchIndex] = node;
    ctx.tails.set(branchIndex, node);
    ctx.hasExplicitSpec = true;
    return { branchIndex, lastExecutableNode: node };
  };
  const attachThenNodeToDecision = (
    ctx: DecisionContext,
    node: Node,
    currentBranchIndex: number | null,
  ): AttachResult => {
    let branchIndex = currentBranchIndex;
    if (branchIndex === null && ctx.branches.length > 0) {
      branchIndex = ctx.branches.length - 1;
    }
    if (branchIndex !== null) {
      const tail = ctx.tails.get(branchIndex);
      if (tail) {
        gb.pushEdge({ from: tail.id, to: node.id });
        ctx.tails.set(branchIndex, node);
        ctx.hasExplicitSpec = true;
        return { branchIndex, lastExecutableNode: node };
      }
    }
    gb.wireSequential(node);
    return { branchIndex: null, lastExecutableNode: gb.lastExecutableNode };
  };
  const wireIntoDecisionIfAny = (
    node: Node,
    seg: LogicalSegment,
    speckey: string | null,
  ): boolean => {
    const ctx = currentDecision();
    if (!ctx || !isElseOrThen(speckey) || !inDecisionRange(ctx, seg)) {
      return false;
    }
    if (speckey === 'else') {
      const res = attachElseNodeToDecision(ctx, node);
      currentBranchIndex = res.branchIndex;
    } else {
      const res = attachThenNodeToDecision(ctx, node, currentBranchIndex);
      currentBranchIndex = res.branchIndex;
      gb.lastExecutableNode = res.lastExecutableNode;
    }
    return true;
  };
  const handleExecutableNode = (
    kind: NodeKind,
    seg: LogicalSegment,
    gram: Grammar,
    trimmedCode: string,
    speckey: string | null,
  ): Node => {
    const node = createExecutableNode(kind, seg, trimmedCode, gram);

    if (wireIntoDecisionIfAny(node, seg, speckey)) {
      return node;
    }
    popObsoleteDecisions(seg, speckey);
    if (!inFun()) {
      gb.wireSequential(node);
    }
    return node;
  };
  const handleBareElseThen = (seg: LogicalSegment, gram: Grammar): void => {
    const { speckey, trimmedCode } = gram;
    popObsoleteDecisions(seg, speckey);
    const ctx = currentDecision();

    if (!ctx) {
      handleExecutableNode('Process', seg, gram, trimmedCode, speckey);
      return;
    }
    if (speckey === 'else' && ctx.branchIndent === undefined) {
      ctx.branchIndent = seg.indent;
    }
    if (seg.indent < ctx.header.indent) {
      handleExecutableNode('Process', seg, gram, trimmedCode, speckey);
      return;
    }
    const node = createExecutableNode('Process', seg, trimmedCode, gram);
    if (!wireIntoDecisionIfAny(node, seg, speckey)) {
      if (!inFun()) {
        gb.wireSequential(node);
      }
    }
  };
  const closeFun = (seg: LogicalSegment): boolean => {
    if (funStack.length === 0) return false;
    const trimmedEnd = seg.code.trimEnd();
    if (!/\}\s*$/.test(trimmedEnd)) return false;
    const funCtx = funStack.pop()!;
    const header = funCtx.header;

    if (funCtx.bodyNodeIds.length > 0) {
      appendMeta(header, `fun-body=[${funCtx.bodyNodeIds.join(',')}]`);

      const footerText = trimmedEnd.trim();
      const footerGram: Grammar = {
        speckey: null,
        nodekey: null,
        linekey: [],
        trimmedCode: footerText,
      };
      const footerNode = createExecutableNode(
        'Process',
        seg,
        footerText,
        footerGram,
        { skipFunRegister: true },
      );
      appendMeta(footerNode, `fun-footer-of=${header.id}`);
      const lastBodyId = funCtx.lastBodyNodeId!;
      gb.pushEdge({ from: lastBodyId, to: footerNode.id });
      gb.lastExecutableNode = footerNode;
    }
    currentBranchIndex = null;
    return true;
  };
  for (const seg of segments) {
    if (!seg.code.trim() && seg.comment.trim()) {
      const c = seg.comment.trim();
      if (lastNode) {
        appendMeta(lastNode, c);
      }
      continue;
    }
    if (closeFun(seg)) continue;
    const gram = SegGram(seg);
    if (!gram) continue;
    const { speckey, nodekey, linekey, trimmedCode } = gram;

    if (nodekey === 'fun') {
      let afterFun = trimmedCode.trim();
      const isCollapsed = afterFun.startsWith('!');
      if (isCollapsed) {
        afterFun = afterFun.replace(/^!\s*/, '');
      }
      const funName = afterFun.trim();
      const headerText = isCollapsed ? `fun! ${funName}` : `fun ${funName}`;
      const funNode = createExecutableNode(
        'Process',
        seg,
        headerText,
        { speckey, nodekey: null, linekey, trimmedCode: headerText },
        { skipFunRegister: true },
      );
      appendMeta(
        funNode,
        `fun-block ${isCollapsed ? 'collapsed' : 'expanded'}`,
      );
      gb.wireSequential(funNode);
      funStack.push({ header: funNode, bodyNodeIds: [] });
      currentBranchIndex = null;
      continue;
    }
    if (isElseOrThen(speckey) && !nodekey) {
      handleBareElseThen(seg, gram);
      continue;
    }
    if (nodekey === 'end') {
      const ctx = currentDecision();
      const endNode = createExecutableNode('End', seg, trimmedCode, gram);
      appendMeta(endNode, 'explicit end');

      if (ctx && inDecisionRange(ctx, seg)) {
        if (speckey === 'else' || speckey === 'then') {
          wireIntoDecisionIfAny(endNode, seg, speckey);
        } else {
          currentBranchIndex = null;
        }
        gb.lastExecutableNode = null;
        continue;
      } else {
        currentBranchIndex = null;
        const prev = findPrevSequentialCandidate(nodes, endNode);
        gb.lastExecutableNode = prev ?? null;
        continue;
      }
    }
    if (nodekey === 'im' || nodekey === 'ex') {
      const kind: NodeKind = nodekey === 'im' ? 'Input' : 'Output';
      handleExecutableNode(kind, seg, gram, trimmedCode, speckey);
      continue;
    }
    if (nodekey === 'dec') {
      popObsoleteDecisions(seg, speckey);
      currentBranchIndex = null;
      const headerText = trimmedCode;
      const labels = splitDecisionLabels(headerText);
      const decisionNode = createExecutableNode('Decision', seg, headerText, gram);
      const outerCtx = currentDecision();
      const inOuterRange = outerCtx && inDecisionRange(outerCtx, seg);

      if (inOuterRange && isElseOrThen(speckey)) {
        if (speckey === 'else') {
          const res = attachElseNodeToDecision(outerCtx!, decisionNode);
          currentBranchIndex = res.branchIndex;
        } else {
          const res = attachThenNodeToDecision(
            outerCtx!,
            decisionNode,
            currentBranchIndex,
          );
          currentBranchIndex = res.branchIndex;
          gb.lastExecutableNode = res.lastExecutableNode;
        }
      } else if (!inFun()) {
        gb.wireSequential(decisionNode);
      }
      const ctx: DecisionContext = {
        header: decisionNode,
        branches: [],
        tails: new Map<number, Node>(),
        hasExplicitSpec: false,
        ...(labels.length > 1 ? { labels } : {}),
      };
      if (labels.length > 1) {
        decisionNode.meta = `labels: [${labels.join(', ')}]`;
      }
      decisionStack.push(ctx);
      continue;
    }
    if (nodekey === 'ii') {
      const connectorText = trimmedCode;
      const connectorNode = createExecutableNode(
        'Connector',
        seg,
        connectorText || 'ii',
        gram,
      );
      gb.lastConnectorLikeNode = connectorNode;
      gb.lastExecutableNode = connectorNode;
      popObsoleteDecisions(seg, speckey);
      gb.computeConnectorFanin(connectorNode);
      gb.lastExecutableNode = connectorNode;
      if (!inFun()) {
        gb.wireSequential(connectorNode, true);
      }
      continue;
    }
    handleExecutableNode('Process', seg, gram, trimmedCode, speckey);
  }
  for (const node of pendingNextNodes) {
    const nextConn = findNextConnector(nodes, node);
    if (
      nextConn &&
      !edges.some((e) => e.from === node.id && e.to === nextConn.id)
    ) {
      gb.pushEdge({ from: node.id, to: nextConn.id });
    }
  }
  const nonStartEnd = nodes.filter(isNonSentinel);
  const startHasEdge = edges.some((e) => e.from === startNode.id);
  if (!startHasEdge && nonStartEnd.length > 0) {
    gb.pushEdge({ from: startNode.id, to: nonStartEnd[0].id });
  }

  if (nonStartEnd.length >= 2) {
    const first = nonStartEnd[0];
    const second = nonStartEnd[1];
    if (second.kind === 'Connector') {
      if (!edges.some((e) => e.from === first.id && e.to === second.id)) {
        gb.pushEdge({ from: first.id, to: second.id });
      }
    }
  }
  const executableNodes = nodes.filter((n) => n.kind !== 'End');
  let fallthroughNode: Node;
  let endLabel: string;
  if (executableNodes.length > 0) {
    fallthroughNode = executableNodes[executableNodes.length - 1];
    endLabel = 'implicit end';
  } else {
    fallthroughNode = startNode;
    endLabel = 'implicit end (empty doc)';
  }
  const implicitEnd = gb.createImplicitEnd(
    fallthroughNode.line,
    fallthroughNode.segmentIndex,
    endLabel,
  );
  gb.pushEdge({ from: fallthroughNode.id, to: implicitEnd.id });
  endNodeId = implicitEnd.id;

  return {
    nodes,
    edges,
    startNodeId: startNode.id,
    endNodeId,
  };
}