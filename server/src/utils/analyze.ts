import {
	Connection,
	Diagnostic,
	DiagnosticSeverity
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { JSDOM } from 'jsdom';
import { axeSource } from '../lib/axe';
import { LaxLinterSettings } from '../configuration';

// Add type declaration for window.axe
declare global {
	interface Window {
		axe: any;
		runA11yChecks: () => Promise<any>;
	}
}

export class Analyzer {
	private connection: Connection;
	private settings: LaxLinterSettings;

	constructor(connection: Connection, settings: LaxLinterSettings) {
		this.connection = connection;
		this.settings = settings;
	}

	public async analyze(textDocument: TextDocument, progressToken?: string | number): Promise<Diagnostic[]> {
		const text = textDocument.getText();
		const diagnostics: Diagnostic[] = [];

		try {
			this.connection.sendNotification('window/workDoneProgress/report', { token: progressToken, message: 'Creating DOM...' });

			// Initiate a JSDOM instance.
			const dom = new JSDOM(text, {
				url: textDocument.uri,
				runScripts: "outside-only",
				// Include stack traces for errors
				includeNodeLocations: true
			});

			this.connection.sendNotification('window/workDoneProgress/report', { token: progressToken, message: 'Injecting axe-core...' });

			// Add axe-core to the DOM
			dom.window.eval(axeSource);

			// Set the default rules to run if no rules are provided
			const defaultRules = [
				'accesskeys',
				'area-alt',
				'aria-allowed-role',
				'aria-braille-equivalent',
				'aria-conditional-attr',
				'aria-deprecated-role',
				'aria-dialog-name',
				'aria-prohibited-attr',
				'aria-roledescription',
				'aria-treeitem-name',
				'aria-text',
				'audio-caption',
				'blink',
				'duplicate-id',
				'empty-heading',
				'frame-focusable-content',
				'frame-title-unique',
				'heading-order',
				'html-xml-lang-mismatch',
				'identical-links-same-purpose',
				'image-redundant-alt',
				'input-button-name',
				'label-content-name-mismatch',
				'landmark-one-main',
				'link-in-text-block',
				'marquee',
				'meta-viewport',
				'nested-interactive',
				'no-autoplay-audio',
				'role-img-alt',
				'scrollable-region-focusable',
				'select-name',
				'server-side-image-map',
				'skip-link',
				'summary-name',
				'svg-img-alt',
				'tabindex',
				'table-duplicate-name',
				'table-fake-caption',
				'target-size',
				'td-has-header'
			];
			const rules = this.settings.axe.rules.length > 0 ? this.settings.axe.rules : defaultRules;

			// Add our custom runA11yChecks function to the DOM
			// TODO: We should really be using a module here, and just rendering to string so we have more control.
			dom.window.eval(`
                window.runA11yChecks = function() {
                    const axe = window.axe;
                    // Generate a unique identifier for each analysis run if needed
                    const application = "lax-linter-" + Math.random();
                    axe.configure({
                        branding: {
                            application,
                        },
                        noHtml: true, // Ensure axe doesn't expect a full HTML document environment if run differently
                    });
                    return axe.run(document, {
                        elementRef: true,
                        resultTypes: ['violations'], // Focus on violations
                        runOnly: {
                             type: 'rule',
                             values: [${rules.join(',')}]
                        }
                    });
                };
            `);

			this.connection.sendNotification('window/workDoneProgress/report', { token: progressToken, message: 'Running axe-core analysis...' });

			const results = await dom.window.eval('runA11yChecks()');

			this.connection.sendNotification('window/workDoneProgress/report', { token: progressToken, message: 'Processing results...' });

			// Process results
			if (results && typeof results === 'object' && 'violations' in results) {
				const axeResults = results as any; // Consider defining a stricter type for axe results
				axeResults.violations.forEach((violation: any) => {

					// Find the corresponding range in the original document
					// This part needs refinement based on how JSDOM maps locations or how errors can be traced back.
					// For now, defaulting to the start of the document or a placeholder.
					// JSDOM's includeNodeLocations might help here if errors can be caught and traced.
					// const nodeLocation = violation.nodes[0]?.node?.sourceLocation; // Example, might need JSDOM specifics
					const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }; // Placeholder

					// Map axe-core impact to DiagnosticSeverity
					let severity: DiagnosticSeverity = DiagnosticSeverity.Warning;
					if (violation.impact) {
						switch (violation.impact.toLowerCase()) {
							case 'critical':
							case 'serious':
								severity = DiagnosticSeverity.Error;
								break;
							case 'moderate':
								severity = DiagnosticSeverity.Warning;
								break;
							case 'minor':
								severity = DiagnosticSeverity.Information;
								break;
						}
					}

					const diagnostic: Diagnostic = {
						severity: severity,
						range: range, // Use the calculated range
						message: `${violation.help} (Rule: ${violation.id})`,
						source: 'lax-linter',
						code: violation.id,
						codeDescription: {
							href: violation.helpUrl
						}
					};
					diagnostics.push(diagnostic);
				});
			}

		} catch (error) {
			this.connection.console.error(`Error during analysis of ${textDocument.uri}: ${error}`);
			// Optionally, return a diagnostic indicating the analysis error itself
		}

		return diagnostics;
	}
}