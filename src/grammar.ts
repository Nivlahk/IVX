import { Node, Edge } from './graph';

export interface LogicalSegment {
  physicalLine: number;
  segmentIndex: number;
  indent: number;
  raw: string;
  code: string;
  comment: string;
}

export interface DecisionContext {
  header: Node;
  branches: Node[];
  tails: Map<number, Node>;
  labels?: string[];
  branchIndent?: number;
  hasExplicitSpec: boolean;
}

export interface FunContext {
  header: Node;
  bodyNodeIds: number[];
  lastBodyNodeId?: number;
}

export interface Grammar {
  speckey: string | null;
  nodekey: string | null;
  linekey: string[];
  trimmedCode: string;
}

export const SPEC_KEYS = new Set(['else', 'then']);
export const NODE_KEYS = new Set(['dec', 'ii', 'end', 'do', 'fun', 'im', 'ex']);
export const INLINE_KEYS = new Set(['if', 'of', 'loop', 'next']);

export function normalizeIvxToken(t: string): string {
  return t.startsWith('@') ? t.slice(1) : t;
}

export function splitDecisionLabels(text: string): string[] {
  return text
    .split(/\s*,\s*/)
    .map((label) => label.trim())
    .filter(Boolean);
}

export function splitCodeAndComment(raw: string): { code: string; comment: string } {
  let code = '';
  let comment = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      code += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      code += ch;
      continue;
    }
    if (ch === '#' && !inSingle && !inDouble) {
      i++; // Skip past #
      while (i < raw.length) {
        comment += raw[i];
        i++;
      }
      break;
    }
    code += ch;
  }
  return { code, comment };
}

export function computeIndent(indentString: string): number {
  let indent = 0;
  let spaceCount = 0;

  for (const ch of indentString) {
    if (ch === '\t') {
      indent++;
      spaceCount = 0;
    } else if (ch === ' ') {
      if (++spaceCount === 4) {
        indent++;
        spaceCount = 0;
      }
    }
  }
  return indent;
}

export function collectSegments(text: string): LogicalSegment[] {
  const segments: LogicalSegment[] = [];
  text.split(/\r?\n/).forEach((line, lineIndex) => {
    line.split(':').forEach((segText, segIndex) => {
      let raw = segText;
      if (/^\s*$/.test(raw)) return;
      const indentString = raw.match(/^([ \t]*)/)?.[1] ?? '';
      const indent = computeIndent(indentString);
      raw = raw.replace(/^[ \t]*/, '');
      const { code, comment } = splitCodeAndComment(raw);
      segments.push({
        physicalLine: lineIndex,
        segmentIndex: segIndex,
        indent,
        raw,
        code,
        comment,
      });
    });
  });
  return segments;
}

export function SegGram(seg: LogicalSegment): Grammar | null {
  const trimmed = seg.code.trim();
  if (!trimmed || /^\\+$/.test(trimmed)) return null;
  const tokens = trimmed.split(/\s+/);
  let speckey: string | null = null;
  let nodekey: string | null = null;
  const linekey: string[] = [];
  let i = 0;

  if (i < tokens.length) {
    const norm0 = normalizeIvxToken(tokens[i]);
    let first = norm0;
    let collapsedBang = false;
    if (norm0 === 'fun!' || norm0 === 'fun!{') {
      first = 'fun';
      collapsedBang = true;
    }
    if (SPEC_KEYS.has(first)) {
      speckey = first;
      i++;
    } else if (NODE_KEYS.has(first)) {
      nodekey = first;
      i++;
      if (collapsedBang) {
        tokens.splice(i, 0, '!');
      }
    }
  }
  if (i < tokens.length) {
    const norm = normalizeIvxToken(tokens[i]);
    if (SPEC_KEYS.has(norm)) {
      speckey = norm;
      i++;
    }
  }
  if (i < tokens.length) {
    const norm = normalizeIvxToken(tokens[i]);
    if (NODE_KEYS.has(norm)) {
      nodekey = norm;
      i++;
    }
  }
  const userTokens: string[] = [];
  for (let j = i; j < tokens.length; j++) {
    const norm = normalizeIvxToken(tokens[j]);
    if (INLINE_KEYS.has(norm)) {
      linekey.push(norm);
    } else {
      userTokens.push(tokens[j]);
    }
  }
  const trimmedCode = userTokens.join(' ').trim();
  return { speckey, nodekey, linekey, trimmedCode };
}

export function isElseOrThen(s: string | null | undefined): boolean {
  return s === 'else' || s === 'then';
}