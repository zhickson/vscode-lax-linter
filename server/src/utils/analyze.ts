import {
	Connection,
	Diagnostic,
	DiagnosticSeverity,
	Range,
	Position
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { JSDOM } from 'jsdom';
import { axeSource } from '../lib/axe';
import { LaxLinterSettings } from '../configuration';
import axe from 'axe-core';

// Add type declaration for window.axe
declare global {
	interface Window {
		axe: any;
		runA11yChecks: () => Promise<any>;
	}
}

/**
 * Analyzes a text document for accessibility issues using axe-core.
 * @param textDocument - The text document to analyze.
 * @param progressToken - Optional progress token for reporting.
 * @returns An array of diagnostics containing accessibility issues.
 */
export class Analyzer {
	private connection: Connection;
	private settings: LaxLinterSettings;

	constructor(connection: Connection, settings: LaxLinterSettings) {
		this.connection = connection;
		this.settings = settings;
	}

	/**
	 * Analyzes the given text document for accessibility issues.
	 * @param textDocument - The text document to analyze.
	 * @param progressToken - Optional progress token for reporting.
	 * @returns An array of diagnostics containing accessibility issues.
	 */
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
				const newlineCount = (match.match(/\n/g) || []).length;

				// Create an empty <span> element that spans the same number of lines
				// Start the span, add the required number of newlines, then close it.
				// NOTE: This is a hack to preserve the line numbers of the original text.
				//       This is not ideal for inline PHP within HTML tags
				const replacementSpan = '<span>' + '\n'.repeat(newlineCount) + '</span>';
				return replacementSpan;
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
			// Adapted from https://developer.chrome.com/docs/lighthouse/accessibility/scoring
			let defaultRules = [
				'accesskeys',
				'aria-allowed-attr',
				'aria-allowed-role',
				'aria-command-name',
				'aria-command-name',
				'aria-dialog-name',
				'aria-hidden-body',
				'aria-hidden-focus',
				'aria-input-field-name',
				'aria-meter-name',
				'aria-progressbar-name',
				'aria-required-attr',
				'aria-required-children',
				'aria-required-parent',
				'aria-roles',
				'aria-text',
				'aria-toggle-field-name',
				'aria-tooltip-name',
				'aria-treeitem-name',
				'aria-valid-attr-value',
				'aria-valid-attr',
				'button-name',
				'bypass',
				'definition-list',
				'dlitem',
				'duplicate-id-active',
				'duplicate-id-aria',
				'form-field-multiple-labels',
				'frame-title',
				'heading-order',
				'image-alt',
				'image-redundant-alt',
				'input-button-name',
				'input-image-alt',
				'label-content-name-mismatch',
				'label',
				'link-in-text-block',
				'link-name',
				'list',
				'listitem',
				'meta-refresh',
				'meta-viewport',
				'object-alt',
				'select-name',
				'skip-link',
				'tabindex',
				'table-duplicate-name',
				'table-fake-caption',
				'td-has-header',
				'td-headers-attr',
				'th-has-data-cells',
				'video-caption'
			];

			// If the file is not a PHP file, include these head specific rules.
			if (!textDocument.uri.endsWith('.php')) {
				defaultRules.push('html-has-lang');
				defaultRules.push('html-lang-valid');
				defaultRules.push('html-xml-lang-mismatch');
				defaultRules.push('valid-lang');
				defaultRules.push('document-title');
			}

			// Ensure settings and rules array exist before accessing
			const rulesToRun = defaultRules.map(rule => `"${rule}"`);

			// Add our custom runA11yChecks function to the DOM
			dom.window.eval(`
                window.runA11yChecks = function() {
                    const axe = window.axe;
                    axe.configure({
                        noHtml: true, // Keep this configuration
                    });
                    return axe.run(document, {
                        elementRef: true,
                        resultTypes: ['violations'], // Focus on violations
                        runOnly: {
                            type: 'rule',
                            values: [${rulesToRun.join(',')}] // Use the injected rules array
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
					const axeResults = results as axe.AxeResults;
					// Iterate through each VIOLATION reported by Axe
					axeResults.violations.forEach((violation: axe.Result) => {

						// Check if this violation has associated nodes
						if (violation.nodes && violation.nodes.length > 0) {
							// Iterate through each NODE within this violation
							violation.nodes.forEach((node: axe.NodeResult) => {
								// --- Calculate Range for the CURRENT node ---
								let range: Range = { // Default range (start of document)
									start: Position.create(0, 0),
									end: Position.create(0, 0)
								};

								try {
									// Check if target selector array exists for the current node
									if (node.target && node.target.length > 0) {
										// Get the first selector from the target array for the current node
										const firstSelector = node.target[0];

										// Ensure the first selector is a string before using querySelector
										if (typeof firstSelector === 'string') {
											try {
												// Query the JSDOM document using the string selector
												const element = dom.window.document.querySelector(firstSelector);
												if (element) {
													const domLocation = dom.nodeLocation(element);
													// Check if JSDOM provided source location on the *queried* element
													if (domLocation &&
														typeof domLocation.startLine === 'number' &&
														typeof domLocation.startCol === 'number' &&
														typeof domLocation.endLine === 'number' &&
														typeof domLocation.endCol === 'number') {
														const sourceLoc = domLocation;
														// Convert JSDOM's 1-based line, 0-based col to VSCode's 0-based line, 0-based char
														range = Range.create(
															Position.create(sourceLoc.startLine - 1, sourceLoc.startCol),
															Position.create(sourceLoc.endLine - 1, sourceLoc.endCol)
														);
													} else {
														this.connection.console.log(`Source location missing for element selected by: ${firstSelector}`);
													}
												} else {
													this.connection.console.warn(`Could not find element using selector: ${firstSelector}`);
												}
											} catch (querySelectorError) {
												this.connection.console.warn(`Error using querySelector for '${firstSelector}': ${querySelectorError}`);
											}
										} else {
											// Log if the first selector wasn't a string (e.g., Shadow DOM)
											this.connection.console.log(`First target selector for node in violation ${violation.id} is not a string, using default range.`);
										}
									}
								} catch (locError) {
									this.connection.console.warn(`Error processing location for node in violation ${violation.id}: ${locError}`);
									// Fallback range is already set
								}
								// --- End Range Calculation ---

								// Map axe-core impact to DiagnosticSeverity (use the violation's impact)
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

								// Create a diagnostic for this specific node
								const diagnostic: Diagnostic = {
									severity: severity,
									range: range, // Use the calculated or default range for this node
									message: `${violation.description}`,
									source: 'lax-linter',
									code: violation.id,
									codeDescription: {
										href: violation.helpUrl
									},
								};
								diagnostics.push(diagnostic);
							}); // End loop for nodes within a violation
						}
					}); // End loop for violations
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