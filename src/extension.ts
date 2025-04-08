import * as path from 'path';
import {
	workspace,
	ExtensionContext,
	window,
	commands,
	languages
} from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

let client: LanguageClient;

export async function activate(context: ExtensionContext) {
	try {
		// The server is implemented in node
		const serverModule = context.asAbsolutePath(path.join('out', 'server', 'src', 'server.js'));

		// If the extension is launched in debug mode then the debug server options are used
		// Otherwise the run options are used
		const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

		// Options to control the language client
		const serverOptions: ServerOptions = {
			run: {
				module: serverModule,
				transport: TransportKind.ipc
			},
			debug: {
				module: serverModule,
				transport: TransportKind.ipc,
				options: debugOptions
			}
		};

		const clientOptions: LanguageClientOptions = {
			// Register the server for HTML and PHP documents
			// TODO: Add support for more languages natively, such as JSX/React, etc.
			documentSelector: [
				{ scheme: 'file', language: 'html' },
				{ scheme: 'file', language: 'php' }
			],
			synchronize: {
				// Notify the server about file changes to '.clientrc files contain in the workspace
				fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
			}
		};

		// Create the language client and start the client
		client = new LanguageClient(
			'laxLinter',
			'Lighthouse Accessibility Linter',
			serverOptions,
			clientOptions
		);

		// Start the client. This will also launch the server
		client.start();
	} catch (error: unknown) {
		console.error('Failed to activate extension:', error);
		const errorMessage = error instanceof Error ? error.message : String(error);
		window.showErrorMessage('Failed to start Lighthouse Accessibility Linter: ' + errorMessage);
	}
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}

	return client.stop();
}