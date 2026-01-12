import * as vscode from 'vscode';
import { validNodeIO } from './graph';
import { parseivx } from './parser';

const diagnosticCollection = vscode.languages.createDiagnosticCollection('lahk');

let realtimePanel: vscode.WebviewPanel | null = null;
let lastLahkDocUri: string | null = null;
let realtimeContext: WebviewContext | null = null;

const realtimeUpdateDebounce = new Map<string, NodeJS.Timeout>();

type WebviewContext = {
  doc: vscode.TextDocument;
};

function isivx(doc: vscode.TextDocument): boolean {
  const { languageId, fileName } = doc;
  return languageId === 'lahk' || fileName.endsWith('.ivx');
}

function buildGraph(doc: vscode.TextDocument) {
  const graph = parseivx(doc);
  const errors = validNodeIO(graph.nodes, graph.edges);
  graph.validationErrors = errors;
  return { graph, errors };
}

function createDiagnostics(
  doc: vscode.TextDocument,
  errors: string[],
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  for (const error of errors) {
    const lineMatch = error.match(/L(\d+)/);
    const range = lineMatch
      ? new vscode.Range(
          parseInt(lineMatch[1], 10) - 1,
          0,
          parseInt(lineMatch[1], 10) - 1,
          1000,
        )
      : new vscode.Range(0, 0, doc.lineCount - 1, 1000);
    diagnostics.push(
      new vscode.Diagnostic(range, error, vscode.DiagnosticSeverity.Error),
    );
  }
  return diagnostics;
}

function validateDocument(doc: vscode.TextDocument) {
  if (!isivx(doc)) return;

  try {
    const { errors } = buildGraph(doc);
    const diagnostics = createDiagnostics(doc, errors);

    diagnosticCollection.set(doc.uri, diagnostics);

    vscode.window.setStatusBarMessage(
      diagnostics.length === 0
        ? 'Lahk: Graph valid ✓'
        : `Lahk: ${diagnostics.length} graph error(s)`,
      diagnostics.length === 0 ? 3000 : 5000,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const diagnostics: vscode.Diagnostic[] = [
      new vscode.Diagnostic(
        new vscode.Range(0, 0, doc.lineCount - 1, 1000),
        `Parse error: ${errorMessage}`,
        vscode.DiagnosticSeverity.Error,
      ),
    ];
    diagnosticCollection.set(doc.uri, diagnostics);
    vscode.window.setStatusBarMessage('Lahk: Parse error', 5000);
  }
}

function rewriteSegment(
  lineText: string,
  segmentIndex: number,
  newText: string,
): string | null {
  const commentIdx = lineText.indexOf('//');
  const beforeComment =
    commentIdx === -1 ? lineText : lineText.slice(0, commentIdx);
  const commentPart = commentIdx === -1 ? '' : lineText.slice(commentIdx);
  const m = beforeComment.match(/^(\s*[\-\>\*]*\s*)(.*)$/);
  if (!m) return null;
  const prefix = m[1];
  return prefix + newText + commentPart;
}

async function applyNodeTextEdit(
  doc: vscode.TextDocument,
  msg: { line: number; segmentIndex: number; newText: string },
) {
  const { line, segmentIndex, newText } = msg;
  if (line < 0 || line >= doc.lineCount) {
    vscode.window.showErrorMessage('Lahk: Invalid node line for edit.');
    return;
  }
  const lineText = doc.lineAt(line).text;
  const edited = rewriteSegment(lineText, segmentIndex, newText);
  if (edited == null) {
    vscode.window.showErrorMessage(
      'Lahk: Could not map node back to source line.',
    );
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, doc.lineAt(line).range, edited);
  await vscode.workspace.applyEdit(edit);
}

const runOnIvx =
  (fn: (doc: vscode.TextDocument, editor: vscode.TextEditor) => void | Promise<void>) =>
  () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isivx(editor.document)) {
      vscode.window.showInformationMessage(
        !editor
          ? 'Lahk: No active editor.'
          : `Lahk: Not a Lahk markup file (languageId=${editor.document.languageId}).`,
      );
      return;
    }
    void fn(editor.document, editor);
  };

async function getHtml(context: vscode.ExtensionContext): Promise<string> {
  const flowUri = vscode.Uri.joinPath(context.extensionUri, 'flow.html');
  const bytes = await vscode.workspace.fs.readFile(flowUri);
  return new TextDecoder('utf-8').decode(bytes);
}

function handleWebviewMessage(
  msg: unknown,
  webviewContext: WebviewContext,
  webview: vscode.Webview,
) {
  if (!msg || typeof msg !== 'object') return;

  const typed = msg as {
    type: string;
    line?: number;
    segmentIndex?: number;
    newText?: string;
    nodeId?: number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };

  const doc = webviewContext.doc;

  if (typed.type === 'requestNodeEdit') {
    const { line = -1, segmentIndex = 0, nodeId, x, y, width, height } = typed;

    const lineText =
      line >= 0 && line < doc.lineCount ? doc.lineAt(line).text : '';
    const currentText = lineText.trim();

    webview.postMessage({
      type: 'startNodeEdit',
      nodeId,
      text: currentText,
      x,
      y,
      width,
      height,
      line,
      segmentIndex,
    });
    return;
  }

  if (typed.type === 'commitNodeEdit') {
    const { line = -1, segmentIndex = 0, newText } = typed;
    if (typeof newText !== 'string') return;
    void applyNodeTextEdit(doc, { line, segmentIndex, newText });
  }
}

function getPanelTitle(errorCount: number, live: boolean): string {
  if (errorCount) {
    return live
      ? `Lahk Realtime Graph (${errorCount} errors)`
      : `Lahk Graph (Validation Errors)`;
  }
  return live ? 'Lahk Realtime Graph (Live)' : 'Lahk Graph';
}

function updateRealtimeGraph(doc: vscode.TextDocument) {
  if (!realtimePanel) return;

  try {
    const { graph, errors } = buildGraph(doc);
    realtimePanel.webview.postMessage({
      type: 'graph',
      graph,
      title: getPanelTitle(errors.length, true),
    });
    realtimePanel.title = getPanelTitle(errors.length, true);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    realtimePanel.webview.postMessage({
      type: 'error',
      message: `Parse error: ${errorMsg}`,
      title: 'Lahk Realtime Graph (Parse Error)',
    });
    realtimePanel.title = 'Lahk Realtime Graph (Parse Error)';
  }
}

function updateRealtimePanel(doc: vscode.TextDocument) {
  if (!realtimePanel || !isivx(doc)) return;

  const key = lastLahkDocUri || doc.uri.toString();
  const existing = realtimeUpdateDebounce.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  const timeout = setTimeout(() => {
    realtimeUpdateDebounce.delete(key);
    const targetDoc =
      (lastLahkDocUri &&
        vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === lastLahkDocUri,
        )) || doc;
    if (targetDoc && isivx(targetDoc)) {
      // keep the webview context in sync with the current doc
      if (realtimeContext) {
        realtimeContext.doc = targetDoc;
      }
      updateRealtimeGraph(targetDoc);
    }
  }, 250);
  realtimeUpdateDebounce.set(key, timeout);
}

function validateAndUpdate(doc: vscode.TextDocument) {
  if (!isivx(doc)) return;
  lastLahkDocUri = doc.uri.toString();
  validateDocument(doc);
  updateRealtimePanel(doc);
}

async function showRealtimePanel(
  doc: vscode.TextDocument,
  context: vscode.ExtensionContext,
) {
  realtimePanel = vscode.window.createWebviewPanel(
    'lahkRealtimeGraph',
    'Lahk Realtime Graph (Live)',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  // initialize the realtime webview context with the opening document
  realtimeContext = { doc };

  realtimePanel.webview.html = await getHtml(context);
  realtimePanel.webview.onDidReceiveMessage(
    (msg) => handleWebviewMessage(msg, realtimeContext!, realtimePanel!.webview),
    undefined,
    context.subscriptions,
  );
  realtimePanel.onDidDispose(
    () => {
      realtimePanel = null;
      realtimeContext = null;
      lastLahkDocUri = null;
      realtimeUpdateDebounce.forEach((timeout) => clearTimeout(timeout));
      realtimeUpdateDebounce.clear();
    },
    null,
    context.subscriptions,
  );
  realtimePanel.onDidChangeViewState(
    (e) => {
      if (lastLahkDocUri && e.webviewPanel === realtimePanel) {
        const activeDoc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === lastLahkDocUri,
        );
        if (activeDoc && isivx(activeDoc)) {
          // also sync context here in case view was hidden and then shown
          if (realtimeContext) {
            realtimeContext.doc = activeDoc;
          }
          updateRealtimeGraph(activeDoc);
        }
      }
    },
    null,
    context.subscriptions,
  );
  updateRealtimeGraph(doc);
}

export function activate(context: vscode.ExtensionContext) {
  const validateDisposable = vscode.workspace.onDidChangeTextDocument((event) =>
    validateAndUpdate(event.document),
  );
  const openDisposable = vscode.workspace.onDidOpenTextDocument(
    validateAndUpdate,
  );
  const editorDisposable = vscode.window.onDidChangeActiveTextEditor(
    (editor) => {
      if (editor) validateAndUpdate(editor.document);
    },
  );
  const realtimeDisposable = vscode.commands.registerCommand(
    'lahk.toggleRealtimeGraph',
    async () => {
      if (realtimePanel) {
        realtimePanel.dispose();
        realtimePanel = null;
        realtimeContext = null;
        lastLahkDocUri = null;
        vscode.window.showInformationMessage('Lahk: Realtime graph closed.');
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isivx(editor.document)) {
        vscode.window.showInformationMessage('Lahk: Open a Lahk file first.');
        return;
      }
      lastLahkDocUri = editor.document.uri.toString();
      await showRealtimePanel(editor.document, context);
    },
  );

  vscode.workspace.textDocuments.forEach((doc) => validateAndUpdate(doc));

  const dumpGraphDisposable = vscode.commands.registerCommand(
    'lahk.dumpGraph',
    runOnIvx((doc) => {
      validateDocument(doc);
      const { graph } = buildGraph(doc);
      const output = [
        '=== LAHK GRAPH DUMP ===',
        `Document: ${doc.fileName}`,
        `Total Nodes: ${graph.nodes.length}`,
        `Total Edges: ${graph.edges.length}`,
        `Start Node: ${graph.startNodeId}`,
        `End Node: ${graph.endNodeId ?? 'none'}`,
        ...(graph.validationErrors?.length
          ? ['=== VALIDATION ERRORS ===', ...graph.validationErrors!, '']
          : []),
        '=== NODES (id kind line seg indent text // meta) ===',
        ...graph.nodes.map(
          (n) =>
            `N${n.id.toString().padStart(3)} [${n.kind.padEnd(12)}] L${n.line
              .toString()
              .padStart(3)} S${n.segmentIndex
              .toString()
              .padStart(2)} I${n.indent
              .toString()
              .padStart(2)} "${n.text}"${
              n.meta ? ` // ${n.meta}` : ''
            }`,
        ),
        '',
        '=== EDGES (from -> to [label]) ===',
        ...graph.edges.map(
          (e) =>
            `N${e.from.toString().padStart(3)} -> N${e.to
              .toString()
              .padStart(3)}${e.label ? ` [${e.label}]` : ''}`,
        ),
        '',
        '=== JSON (copy for tooling/debugging) ===',
        JSON.stringify(graph, null, 2),
      ].join('\n');

      console.log(output);

      vscode.window.showInformationMessage(
        graph.validationErrors?.length
          ? `Lahk: dumpGraph ready (${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.validationErrors.length} errors). Check Debug Console.`
          : `Lahk: dumpGraph ready (${graph.nodes.length} nodes, ${graph.edges.length} edges). Check Debug Console.`,
      );
    }),
  );

  const showGraphDisposable = vscode.commands.registerCommand(
    'lahk.showGraph',
    runOnIvx(async (doc) => {
      if (realtimePanel) {
        vscode.window.showInformationMessage(
          'Lahk: Use "Lahk: Toggle Realtime Graph" for live updates.',
        );
        realtimePanel.reveal(vscode.ViewColumn.Beside);
        return;
      }
      validateDocument(doc);
      const { graph, errors } = buildGraph(doc);
      const panel = vscode.window.createWebviewPanel(
        'lahkGraph',
        getPanelTitle(errors.length, false),
        vscode.ViewColumn.Beside,
        { enableScripts: true },
      );
      panel.webview.html = await getHtml(context);

      const contextForPanel: WebviewContext = { doc };

      panel.webview.postMessage({ type: 'graph', graph });
      panel.webview.onDidReceiveMessage(
        (msg) => handleWebviewMessage(msg, contextForPanel, panel.webview),
        undefined,
        context.subscriptions,
      );
      if (errors.length) {
        vscode.window.showWarningMessage(
          `Graph validation found ${errors.length} errors. Check webview.`,
        );
      }
    }),
  );

  const clearDiagnosticsDisposable = vscode.commands.registerCommand(
    'lahk.clearDiagnostics',
    () => {
      diagnosticCollection.clear();
      vscode.window.showInformationMessage('Lahk: Cleared all diagnostics.');
    },
  );

  context.subscriptions.push(
    validateDisposable,
    openDisposable,
    editorDisposable,
    realtimeDisposable,
    dumpGraphDisposable,
    showGraphDisposable,
    clearDiagnosticsDisposable,
    diagnosticCollection,
  );
}

export function deactivate() {
  realtimePanel?.dispose();
  realtimeUpdateDebounce.forEach((timeout) => clearTimeout(timeout));
  realtimeUpdateDebounce.clear();
  lastLahkDocUri = null;
}