import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    TextDocumentSyncKind,
    InitializeResult,
    Range,
    Position,
    TextDocumentChangeEvent,
    Disposable
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as axe from 'axe-core';
import { JSDOM } from 'jsdom';
import { WcagLinterSettings, defaultSettings, getDocumentSettings, setConfigurationCapability, updateGlobalSettings, clearDocumentSettings } from './configuration';

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// --- Debouncing Setup ---
let validationTimeout: NodeJS.Timeout | undefined = undefined;

// --- Locking Setup ---
const validatingDocuments = new Set<string>();

// --- Progress Counter ---
let progressCounter = 0;

// --- Configuration Setup ---
let currentSettings: WcagLinterSettings = defaultSettings;
let hasWorkspaceFolderCapability = false;

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;
    const configCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
    setConfigurationCapability(configCapability);
    hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
        }
    };

    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true
            }
        };
    }

    return result;
});

connection.onInitialized(() => {
    connection.client.register(DidChangeConfigurationNotification.type, undefined);

    connection.workspace.getConfiguration('laxLinter').then(settings => {
        updateGlobalSettings(settings);
        currentSettings = settings || defaultSettings;
    });
});

connection.onDidChangeConfiguration(change => {
    updateGlobalSettings(change.settings.laxLinter);
    currentSettings = change.settings.laxLinter || defaultSettings;
    documents.all().forEach(doc => triggerValidation(doc));
});

documents.onDidClose(e => {
    // Clear diagnostics for the closed document
    connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

documents.onDidChangeContent(change => {
    if (currentSettings.run === 'onType') {
        triggerValidation(change.document);
    }
});

documents.onDidSave(change => {
    if (currentSettings.run === 'onSave') {
        validateTextDocument(change.document);
    }
});

function triggerValidation(textDocument: TextDocument) {
    if (validationTimeout) {
        clearTimeout(validationTimeout);
    }
    validationTimeout = setTimeout(() => {
        validateTextDocument(textDocument);
    }, currentSettings.debounceDelay >= 0 ? currentSettings.debounceDelay : 500);
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    if (!currentSettings.enable) {
        connection.console.log('Lighthouse Accessibility Linter disabled via settings.');
        connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
        return;
    }
    if (!currentSettings.includedLanguages.includes(textDocument.languageId)) {
        connection.console.log(`Skipping validation for language: ${textDocument.languageId}`);
        return;
    }
    const fileSize = Buffer.byteLength(textDocument.getText(), 'utf8');
    if (currentSettings.maxFileSize > 0 && fileSize > currentSettings.maxFileSize) {
        connection.console.log(`Skipping validation for large file (${fileSize} bytes): ${textDocument.uri}`);
        connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
        return;
    }

    if (validatingDocuments.has(textDocument.uri)) {
        connection.console.log(`Skipping validation for ${textDocument.uri} as it is already in progress.`);
        return;
    }

    const text = textDocument.getText();
    const diagnostics: Diagnostic[] = [];
    let progressToken: string | number | undefined = undefined;

    try {
        progressToken = `lax-linting/${progressCounter++}`;
        await connection.sendRequest('window/workDoneProgress/create', { token: progressToken });

        validatingDocuments.add(textDocument.uri);
        connection.sendNotification('window/workDoneProgress/begin', {
            token: progressToken,
            title: 'Lighthouse Accessibility Linting',
            message: 'Analyzing document...',
            cancellable: false
        });
        connection.console.log(`Starting validation for ${textDocument.uri}`);

        connection.sendNotification('window/workDoneProgress/report', { token: progressToken, message: 'Creating DOM...' });
        const dom = new JSDOM(text, {
            url: textDocument.uri,
            runScripts: "dangerously", // TODO: Is this dangerous?
        });
        const windowWithAxe = dom.window as unknown as {
            axe: typeof axe;
            eval: (script: string) => void;
            document: Document;
            navigator: Navigator
        };

        connection.sendNotification('window/workDoneProgress/report', { token: progressToken, message: 'Injecting axe-core...' });
        windowWithAxe.eval(axe.source);

        // TODO: Make this configurable
        const axeOptions: axe.RunOptions = {
            resultTypes: ['violations'],
            runOnly: {
                type: 'tag',
                values: currentSettings.axe.tags
            },
            rules: currentSettings.axe.rules
        };

        connection.sendNotification('window/workDoneProgress/report', { token: progressToken, message: 'Running axe-core...' });
        const results = await windowWithAxe.axe.run(windowWithAxe.document, axeOptions);

        connection.sendNotification('window/workDoneProgress/report', { token: progressToken, message: 'Processing results...' });
        results.violations.forEach(violation => {
            let severity: DiagnosticSeverity;
            switch (violation.impact) {
                case 'critical': severity = DiagnosticSeverity.Error; break;
                case 'serious': severity = DiagnosticSeverity.Error; break;
                case 'moderate': severity = DiagnosticSeverity.Warning; break;
                case 'minor': severity = DiagnosticSeverity.Information; break;
                default: severity = DiagnosticSeverity.Information; break;
            }

            violation.nodes.forEach(node => {
                let startPos: Position = { line: 0, character: 0 };
                let endPos: Position = { line: 0, character: 1 };
                let locationFound = false;
                let diagnosticMessage = `${violation.help} (${violation.id})`;

                try {
                    const selector = node.target.join(' ');
                    const element = windowWithAxe.document.querySelector(selector);

                    if (element) {
                        const elementHtml = element.outerHTML;
                        const index = text.indexOf(elementHtml);

                        if (index !== -1) {
                            startPos = textDocument.positionAt(index);
                            endPos = textDocument.positionAt(index + elementHtml.length);
                            locationFound = true;
                        } else {
                            const nodeHtmlFallback = node.html || '';
                            const indexFallback = text.indexOf(nodeHtmlFallback);
                            if (indexFallback !== -1) {
                                startPos = textDocument.positionAt(indexFallback);
                                endPos = textDocument.positionAt(indexFallback + nodeHtmlFallback.length);
                                locationFound = true;
                                connection.console.log(`Used node.html fallback for ${violation.id}. Selector: ${selector}`);
                            }
                        }
                    } else {
                        connection.console.log(`Could not find element in JSDOM for ${violation.id}. Selector: ${selector}`);
                        const nodeHtmlFallback = node.html || '';
                        const indexFallback = text.indexOf(nodeHtmlFallback);
                        if (indexFallback !== -1) {
                            startPos = textDocument.positionAt(indexFallback);
                            endPos = textDocument.positionAt(indexFallback + nodeHtmlFallback.length);
                            locationFound = true;
                            connection.console.log(`Used node.html fallback directly for ${violation.id}. Selector: ${selector}`);
                        }
                    }
                } catch (e: any) {
                    connection.console.error(`Error finding node for ${violation.id} using selector "${node.target.join(' ')}": ${e?.message || e}`);
                    const nodeHtmlFallback = node.html || '';
                    const indexFallback = text.indexOf(nodeHtmlFallback);
                    if (indexFallback !== -1) {
                        startPos = textDocument.positionAt(indexFallback);
                        endPos = textDocument.positionAt(indexFallback + nodeHtmlFallback.length);
                        locationFound = true;
                        connection.console.log(`Used node.html fallback after error for ${violation.id}.`);
                    }
                }

                if (!locationFound) {
                    diagnosticMessage = `[Position not precise] ${diagnosticMessage}`;
                    connection.console.log(`Could not map source position for ${violation.id}. Selector: ${node.target.join(' ')}`);
                }

                const diagnostic: Diagnostic = {
                    severity: severity,
                    range: { start: startPos, end: endPos },
                    message: diagnosticMessage,
                    source: 'lax-linter',
                    code: violation.id,
                    codeDescription: {
                        href: violation.helpUrl
                    }
                };
                diagnostics.push(diagnostic);
            });
        });

        connection.sendNotification('window/workDoneProgress/end', { token: progressToken, message: 'Linting complete.' });

    } catch (error: any) {
        connection.console.error(`Error running axe-core check for ${textDocument.uri}: ${error?.message || error}`);
        diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            message: `Error running accessibility check: ${error?.message || error}`,
            source: 'lax-linter'
        });
        if (progressToken) {
            connection.sendNotification('window/workDoneProgress/end', { token: progressToken, message: 'Linting failed.' });
        }
    } finally {
        validatingDocuments.delete(textDocument.uri);
        connection.console.log(`Finished validation for ${textDocument.uri}`);
    }

    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

documents.listen(connection);
connection.listen();