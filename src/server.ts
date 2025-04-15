import {
	createConnection,
	TextDocuments,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	TextDocumentSyncKind,
	InitializeResult,
	Connection
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LaxLinterSettings, defaultSettings, setConfigurationCapability, updateGlobalSettings, clearDocumentSettings } from './configuration';
import { Analyzer } from './utils/analyze';

// Create a connection for the server
const connection: Connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// --- Debouncing Setup ---
let validationTimeout: NodeJS.Timeout | undefined = undefined;

// --- Locking Setup ---
const validatingDocuments = new Set<string>();

// --- Progress Counter ---
let progressCounter = 0;

// --- Configuration Setup ---
let currentSettings: LaxLinterSettings = defaultSettings;
let hasWorkspaceFolderCapability = false;

// --- Analyzer Instance ---
let analyzer: Analyzer = new Analyzer(connection, currentSettings);

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
		analyzer = new Analyzer(connection, currentSettings);
	});
});

connection.onDidChangeConfiguration(change => {
	updateGlobalSettings(change.settings.laxLinter);
	currentSettings = change.settings.laxLinter || defaultSettings;
	analyzer = new Analyzer(connection, currentSettings);
	documents.all().forEach(doc => triggerValidation(doc));
});

documents.onDidClose(e => {
	connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
	validatingDocuments.delete(e.document.uri);
	clearDocumentSettings();
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
	const text = textDocument.getText();
	const fileSize = Buffer.byteLength(text, 'utf8');
	if (currentSettings.maxFileSize > 0 && fileSize > currentSettings.maxFileSize) {
		connection.console.log(`Skipping validation for large file (${fileSize} bytes): ${textDocument.uri}`);
		connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
		return;
	}

	if (validatingDocuments.has(textDocument.uri)) {
		connection.console.log(`Skipping validation for ${textDocument.uri} as it is already in progress.`);
		return;
	}

	let progressToken: string | number | undefined = undefined;
	try {
		progressToken = `lax-linting/${progressCounter++}`;
		await connection.sendRequest('window/workDoneProgress/create', { token: progressToken });

		validatingDocuments.add(textDocument.uri);
		connection.sendNotification('window/workDoneProgress/begin', {
			token: progressToken,
			title: 'Lax Linter Analysis',
			message: 'Starting analysis...',
			cancellable: false
		});
		connection.console.log(`Starting validation for ${textDocument.uri}`);

		const diagnostics = await analyzer.analyze(textDocument, progressToken);

		connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
		connection.console.log(`Validation finished for ${textDocument.uri}. Found ${diagnostics.length} issues.`);

	} catch (error) {
		connection.console.error(`Error validating ${textDocument.uri}: ${error}`);
		connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
	} finally {
		validatingDocuments.delete(textDocument.uri);
		if (progressToken) {
			connection.sendNotification('window/workDoneProgress/end', { token: progressToken });
		}
	}
}

documents.listen(connection);
connection.listen();