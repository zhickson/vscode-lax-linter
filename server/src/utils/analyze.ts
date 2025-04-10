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
		// Get the original text
		let documentText = textDocument.getText();
		const diagnostics: Diagnostic[] = [];

		// Pre-process the text to comment out PHP blocks while preserving line counts
		try {
			// Regex to find PHP blocks (<?php ... ?> or <?= ... ?>), including multi-line content
			// The 's' flag allows '.' to match newlines.
			const phpRegex = /<\?(?:php|=)?([\s\S]*?)\?>/gs;

			documentText = documentText.replace(phpRegex, (match) => {
				// Count the number of newline characters within the matched PHP block
				const newlineCount = (match.match(/\\n/g) || []).length;

				// Create an HTML comment that spans the same number of lines
				// Start the comment, add the required number of newlines, then close it.
				const replacementComment = '<!--' + '\\n'.repeat(newlineCount) + '-->';
				return replacementComment;
			});
		} catch (error) {
			this.connection.console.warn(`Error during PHP pre-processing: ${error}. Proceeding with original text.`);
			// If pre-processing fails, we might log it but continue with the original text
			// or handle it differently based on desired robustness.
		}

		try {
			this.connection.sendNotification('window/workDoneProgress/report', { token: progressToken, message: 'Creating DOM...' });

			// Initiate a JSDOM instance using the potentially *processed* text
			const dom = new JSDOM(documentText, { // Use the processed text here
				url: textDocument.uri,
				runScripts: "outside-only",
				includeNodeLocations: true // Keep this, might still be useful
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
			// Ensure settings and rules array exist before accessing
			const rulesToRun = this.settings?.axe?.rules && Array.isArray(this.settings.axe.rules) && this.settings.axe.rules.length > 0
				? this.settings.axe.rules
				: defaultRules;

			// Escape rules for injection into the eval string
			const rulesJson = JSON.stringify(rulesToRun);

			// Add our custom runA11yChecks function to the DOM
			dom.window.eval(`
                window.runA11yChecks = function() {
                    // console.log("runA11yChecks inside DOM"); // Keep or remove debug log as desired
                    const axe = window.axe;
                    axe.configure({
                        noHtml: true, // Keep this configuration
                    });
                    const rules = ${rulesJson};
                    return axe.run(document, {
                        elementRef: true,
                        resultTypes: ['violations'], // Focus on violations
                        runOnly: {
                             type: 'rule',
                             values: rules // Use the injected rules array
                        }
                    });
                };
            `);

			this.connection.sendNotification('window/workDoneProgress/report', { token: progressToken, message: 'Running axe-core analysis...' });

			// Ensure runA11yChecks exists before calling
			if (typeof dom.window.runA11yChecks === 'function') {
				const results = await dom.window.runA11yChecks();
				this.connection.sendNotification('window/workDoneProgress/report', { token: progressToken, message: 'Processing results...' });
				// Process results
				if (results && typeof results === 'object' && 'violations' in results) {
					const axeResults = results as any; // Consider defining a stricter type for axe results
					axeResults.violations.forEach((violation: any) => {

						// TODO: Refine diagnostic range calculation.
						// Placeholder range for now. Need to map Axe node locations back to original doc.
						const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

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
							range: range,
							message: `${violation.help} (Rule: ${violation.id})`,
							source: 'lax-linter',
							code: violation.id,
							codeDescription: {
								href: violation.helpUrl
							},
							tags: violation.tags // Include Axe tags if available
						};
						diagnostics.push(diagnostic);
					});
				}
			} else {
				this.connection.console.error(`runA11yChecks function not found in JSDOM context for ${textDocument.uri}`);
			}

		} catch (error) {
			this.connection.console.error(`Error during analysis of ${textDocument.uri}: ${error}`);
		}

		return diagnostics;
	}
}