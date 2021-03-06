import { grammar, Grammar } from 'ohm-js';
import * as fse from 'fs-extra';
import * as path from 'path';
import { GMLHoverProvider } from './hover';
import { TimeUtil } from './utils';
import {
    IConnection,
    Diagnostic,
    Hover,
    TextDocumentContentChangeEvent,
    TextDocumentPositionParams,
    WorkspaceFolder,
    DidOpenTextDocumentParams,
    CompletionParams,
    CompletionItem,
    ReferenceParams
} from 'vscode-languageserver/lib/main';
import { DiagnosticHandler, DiagnosticsPackage, LintPackage } from './diagnostic';
import { Reference } from './reference';
import { GMLDefinitionProvider } from './definition';
import { GMLSignatureProvider } from './signature';
import { GMLCompletionProvider } from './completion';
import { SemanticsOption, LanguageService, GMLDocs, GMLToolsSettings, DocumentFolder } from './declarations';
import { DocumentationImporter } from './documentationImporter';
import { InitialAndShutdown } from './startAndShutdown';
import { ResourcePackage, ClientViewNode } from './sharedTypes';
import { FileSystem } from './fileSystem';

export class LangServ {
    readonly gmlGrammar: Grammar;
    public fsManager: FileSystem;
    public gmlHoverProvider: GMLHoverProvider;
    public gmlDefinitionProvider: GMLDefinitionProvider;
    public gmlSignatureProvider: GMLSignatureProvider;
    public gmlCompletionProvider: GMLCompletionProvider;
    public reference: Reference;
    public initialStartup: InitialAndShutdown;
    public timer: TimeUtil;
    public userSettings: GMLToolsSettings.Config;
    private originalOpenDocuments: DidOpenTextDocumentParams[];
    readonly __dirName: string;

    constructor(public connection: IConnection) {
        this.connection = connection;
        this.originalOpenDocuments = [];
        this.gmlGrammar = grammar(fse.readFileSync(path.join(__dirname, path.normalize('../lib/gmlGrammar.ohm')), 'utf-8'));
        this.__dirName = path.normalize(__dirname);

        // Create our tools:
        this.reference = new Reference(this);
        this.fsManager = new FileSystem(this.gmlGrammar, this);
        this.initialStartup = new InitialAndShutdown(this.reference, this.gmlGrammar, this);

        //#region Language Services
        this.gmlHoverProvider = new GMLHoverProvider(this.reference, this.fsManager);
        this.gmlDefinitionProvider = new GMLDefinitionProvider(this.reference, this);
        this.gmlSignatureProvider = new GMLSignatureProvider(this.reference, this.fsManager);
        this.gmlCompletionProvider = new GMLCompletionProvider(this.reference, this.fsManager);
        this.timer = new TimeUtil();

        // Basic User Settings
        this.userSettings = {
            numberOfDocumentationSentences: 1,
            preferredSpellings: GMLToolsSettings.SpellingSettings.american
        };
        //#endregion
    }

    //#region Init
    public async workspaceBegin(workspaceFolder: WorkspaceFolder[]) {
        // Check or Create the Manual:
        let ourManual: GMLDocs.DocFile | null;
        let cacheManual = false;
        try {
            const encodedText = fse.readFileSync(path.join(this.__dirName, path.normalize('../lib/gmlDocs.json')), 'utf8');
            ourManual = JSON.parse(encodedText);
        } catch (err) {
            const docImporter = new DocumentationImporter(this, this.reference);
            ourManual = await docImporter.createManual();
            cacheManual = true;
        }

        // If we have a manual, load it into memory:
        if (ourManual) {
            // Load our Manual into Memory
            this.reference.initDocs(ourManual);

            // Cache the Manual:
            if (cacheManual) {
                fse.writeFileSync(path.join(this.__dirName, path.normalize('../lib/gmlDocs.json')), JSON.stringify(ourManual, null, 4));
            }

            this.connection.window.showInformationMessage('Manual succesfully loaded.');
        } else {
            this.connection.window.showWarningMessage(
                'Manual not correctly loaded. Please make sure GMS2 is\ninstalled correctly. If the error persists,\n please log an error on the Github page.'
            );
        }

        // Index our YYP
        const fsHandoff = await this.initialStartup.initialWorkspaceFolders(workspaceFolder);
        if (fsHandoff) await this.fsManager.initHandOff(fsHandoff);

        // Create project-documentation
        if ((await this.fsManager.isFileCached('project-documentation.json')) == false) {
            this.fsManager.initProjDocs(this.__dirName);
        }

        // Install Watcher:
        this.fsManager.installProjectDocWatcher(this.__dirName);

        // Get our Configuration
        this.userSettings = await this.connection.workspace.getConfiguration({
            section: 'gml-tools'
        });

        // Assign our settings, per setting:
        this.gmlHoverProvider.numberOfSentences = this.userSettings.numberOfDocumentationSentences;

        // Update our View
        await this.updateViews();
    }

    public async findNewSettings(): Promise<{ [prop: string]: string }> {
        if (!this.userSettings) return {};
        // Get our Settings:
        const newSettings = await this.connection.workspace.getConfiguration({
            section: 'gml-tools'
        });

        // Iterate over to find our changed settings:
        const ourSettings = Object.keys(newSettings);
        let changedSettings: any = {};

        for (const thisSetting of ourSettings) {
            if (JSON.stringify(newSettings[thisSetting]) != JSON.stringify(this.userSettings[thisSetting])) {
                changedSettings[thisSetting] = newSettings[thisSetting];
            }
        }

        // Commit our changed Configs
        return changedSettings;
    }

    public async updateSettings(changedSettings: { [key: string]: any }) {
        const newSettings = Object.keys(changedSettings);

        // Iterate on the settings
        for (const thisSetting of newSettings) {
            if (thisSetting == 'preferredSpellings') {
                if (
                    changedSettings[thisSetting] == GMLToolsSettings.SpellingSettings.american ||
                    changedSettings[thisSetting] == GMLToolsSettings.SpellingSettings.british ||
                    changedSettings[thisSetting] == GMLToolsSettings.SpellingSettings.noPref
                ) {
                    this.userSettings.preferredSpellings = changedSettings[thisSetting];

                    this.connection.window.showWarningMessage('Please Restart VSCode for Setting to Take Effect.');

                    try {
                        this.fsManager.deletedCachedFile('gmlDocs.json');
                    } catch (err) {
                        throw err;
                    }
                }
            }

            if (thisSetting == 'numberOfDocumentationSentences') {
                this.userSettings.numberOfDocumentationSentences = changedSettings[thisSetting];
                // Assign our settings, per setting:
                this.gmlHoverProvider.numberOfSentences = this.userSettings.numberOfDocumentationSentences;
            }
        }
    }

    public isServerReady() {
        return this.fsManager.indexComplete;
    }
    //#endregion

    //#region Shutdown
    public async cacheProject() {
        const fileHandOff = await this.reference.shutdownHandoff();
        this.fsManager.shutdownCache(fileHandOff);
    }

    //#endregion

    //#region Text Events
    public async openTextDocument(params: DidOpenTextDocumentParams) {
        // Commit to open Q if indexing still...
        if (this.isServerReady() == false) {
            this.originalOpenDocuments.push(params);
            return;
        }

        const uri = params.textDocument.uri;
        const text = params.textDocument.text;

        const thisDiagnostic = await this.fsManager.getDiagnosticHandler(uri);
        await thisDiagnostic.setInput(text);
        const docInfo = await this.fsManager.addDocument(uri, text);
        if (!docInfo) return;
        this.fsManager.addOpenDocument(uri);

        const finalDiagnosticPackage = await this.lint(thisDiagnostic, SemanticsOption.All, docInfo);

        // Send Final Diagnostics
        this.connection.sendDiagnostics(DiagnosticsPackage.create(uri, finalDiagnosticPackage));
    }

    public async changedTextDocument(uri: string, contentChanges: Array<TextDocumentContentChangeEvent>) {
        if (this.isServerReady() == false) return;

        // Find our Diagnostic:
        const thisDiagnostic = await this.fsManager.getDiagnosticHandler(uri);

        // Set our Input: TODO make this server actually incremental.
        for (const contentChange of contentChanges) {
            await thisDiagnostic.setInput(contentChange.text);
        }

        const docInfo = await this.fsManager.addDocument(uri, thisDiagnostic.getInput());
        if (!docInfo) return;

        const finalDiagnosticPackage = await this.lint(thisDiagnostic, SemanticsOption.All, docInfo);
        // Send Final Diagnostics
        this.connection.sendDiagnostics(DiagnosticsPackage.create(uri, finalDiagnosticPackage));
    }
    //#endregion

    //#region Diagnostics
    public async getMatchResultsPackage(thisDiagnostic: DiagnosticHandler, lintPackage: LintPackage) {
        if (thisDiagnostic.match() == false) {
            await thisDiagnostic.primarySyntaxLint(lintPackage);

            return lintPackage.getDiagnostics();
        } else {
            // get our Signature token list (we do this in Primary Syntax on success...)
            await thisDiagnostic.createSignatureTokenListGoodMatch();

            lintPackage.setMatchResultsPackage([
                {
                    indexRange: { startIndex: 0 },
                    matchResult: thisDiagnostic.getMatchResult()
                }
            ]);
            return lintPackage.getDiagnostics();
        }
    }

    public async lint(thisDiagnostic: DiagnosticHandler, bit: SemanticsOption, docInfo: DocumentFolder) {
        let lintPack = new LintPackage();
        const initDiagnostics = await this.getMatchResultsPackage(thisDiagnostic, lintPack);
        const semDiagnostics = await this.runSemantics(thisDiagnostic, lintPack, bit, docInfo);

        return initDiagnostics.concat(semDiagnostics);
    }

    public async runSemantics(thisDiagnostic: DiagnosticHandler, lintPackage: LintPackage, bit: SemanticsOption, docInfo: DocumentFolder) {
        let diagnosticArray: Diagnostic[] = [];

        // Clear out all our Clearables
        await this.reference.URIRecordClearAtURI(thisDiagnostic.getURI);

        // Semantic Lint
        if ((bit & SemanticsOption.Function) == SemanticsOption.Function) {
            await this.semanticLint(thisDiagnostic, lintPackage, diagnosticArray);
        }

        // Variable Index
        if ((bit & SemanticsOption.Variable) == SemanticsOption.Variable) {
            await this.semanticVariableIndex(thisDiagnostic, lintPackage, docInfo);
        }

        // JSDOC
        if ((bit & SemanticsOption.JavaDoc) == SemanticsOption.JavaDoc) {
            if (docInfo.type == 'GMScript') {
                await this.semanticJSDOC(thisDiagnostic, lintPackage, docInfo);
            }
        }

        return thisDiagnostic.popSemanticDiagnostics();
    }

    public async semanticLint(thisDiagnostic: DiagnosticHandler, lintPackage: LintPackage, diagnosticArray: Diagnostic[]) {
        // Run Semantics on Existing MatchResults.
        const theseMatchResults = lintPackage.getMatchResults();
        if (theseMatchResults) {
            await thisDiagnostic.runSemanticLintOperation(theseMatchResults);
        }
    }

    public async semanticVariableIndex(thisDiagnostic: DiagnosticHandler, lintPackage: LintPackage, docInfo: DocumentFolder) {
        const theseMatchResults = lintPackage.getMatchResults();
        if (!theseMatchResults) return;

        thisDiagnostic.runSemanticIndexVariableOperation(theseMatchResults, docInfo);
    }

    public async semanticJSDOC(thisDiagnostic: DiagnosticHandler, lintPackage: LintPackage, docInfo: DocumentFolder) {
        // Type Safety and Match Results
        const matchResults = lintPackage.getMatchResults();
        if (!matchResults) return;
        const ourScriptPack = this.reference.scriptGetPackage(docInfo.name);
        if (!ourScriptPack) return;
        const ourJSDOC = await thisDiagnostic.runSemanticJSDOC(matchResults, docInfo.name);
        this.reference.scriptAddJSDOC(ourScriptPack, ourJSDOC);
    }
    //#endregion

    //#region Type Service Calls
    public async hoverOnHover(params: TextDocumentPositionParams): Promise<Hover | null> {
        if (this.isServerReady() == false) return null;
        return await this.gmlHoverProvider.provideHover(params);
    }

    public onDefinitionRequest(params: TextDocumentPositionParams) {
        if (this.isServerReady() == false) return null;
        return this.gmlDefinitionProvider.onDefinitionRequest(params);
    }

    public async onSignatureRequest(params: TextDocumentPositionParams) {
        if (this.isServerReady() == false) return null;
        return await this.gmlSignatureProvider.onSignatureRequest(params);
    }

    public onCompletionRequest(params: CompletionParams) {
        if (this.isServerReady() == false) return null;
        return this.gmlCompletionProvider.onCompletionRequest(params);
    }

    public async onCompletionResolveRequest(params: CompletionItem) {
        if (this.isServerReady() == false) return params;
        return await this.gmlCompletionProvider.onCompletionResolveRequest(params);
    }

    public async onShowAllReferences(params: ReferenceParams) {
        return await this.gmlDefinitionProvider.onShowAllReferencesRequest(params);
    }
    //#endregion

    //#region Commands
    public async updateViews() {
        this.connection.sendNotification('refresh');
    }

    public async createFolder(folderPackage: ResourcePackage) {
        // Make sure our YYP is accurate still
        if ((await this.fsManager.validateYYP(this.connection)) === false) return false;

        // Send it off to the filesystem manager (no reference needed here):
        return await this.fsManager.resourceFolderCreate(folderPackage);
    }

    public async createObject(objectPackage: ResourcePackage) {
        if (await this.genericResourcePreCheck(objectPackage.resourceName)) {
            // If we made it here, send to the FS for the rest.
            return await this.fsManager.resourceObjectCreate(objectPackage);
        } else return null;
    }

    public async deleteObject(objPackage: ResourcePackage) {
        // Make Sure our YYP is accurate
        if ((await this.fsManager.validateYYP(this.connection)) === false) return false;

        // Get info from the FS
        const eventURIs = this.fsManager.resourceObjectGetEventURIsFromObjectID(objPackage.viewUUID);

        const successName = await this.fsManager.resourceObjectDelete(objPackage.viewUUID);
        if (!successName) return false;

        // Delete the Reference Library:
        this.reference.objectDeleteObject(successName);
        if (eventURIs) {
            for (const thisEvent of eventURIs) {
                this.reference.URIRecordDeleteAtURI(thisEvent);
            }
        }

        // Clear the View
        await this.fsManager.viewsDeleteViewAtNode(objPackage.viewUUID);

        return true;
    }

    public async deleteEvent(eventPack: ResourcePackage) {
        // Make Sure our YYP is accurate
        if ((await this.fsManager.validateYYP(this.connection)) === false) return false;

        // Handle FS here:
        const eventURI = await this.fsManager.resourceEventDelete(eventPack.viewUUID, eventPack.resourceName);

        // Reference Clear
        if (eventURI) this.reference.URIRecordDeleteAtURI(eventURI);

        return true;
    }

    public async createScript(scriptPack: ResourcePackage): Promise<null | ClientViewNode> {
        if (await this.genericResourcePreCheck(scriptPack.resourceName)) {
            return await this.fsManager.resourceScriptCreate(scriptPack.resourceName, scriptPack.viewUUID);
        } else return null;
    }

    public async deleteScript(clientScriptPack: ResourcePackage): Promise<boolean> {
        // Make sure our YYP is accurate still
        if ((await this.fsManager.validateYYP(this.connection)) === false) return false;

        // Get the package
        const scriptPack = this.reference.scriptGetPackage(clientScriptPack.resourceName);
        if (!scriptPack) return false;

        // Delete it from the FS and change the YYP
        const success = await this.fsManager.resourceScriptDelete(scriptPack, clientScriptPack.viewUUID);
        if (!success) return false;

        // Delete the Reference library
        this.reference.scriptDelete(clientScriptPack.resourceName);

        // Clear the View
        await this.fsManager.viewsDeleteViewAtNode(clientScriptPack.viewUUID);

        return true;
    }

    public async addEvents(events: ResourcePackage): Promise<ClientViewNode | null> {
        return await this.fsManager.resourceAddEvents(events);
    }

    public beginCompile(type: 'test' | 'zip' | 'installer', yyc: boolean, output?: string) {
        return this.fsManager.compile(type, yyc, output);
    }

    //#endregion

    //#region Utilities
    public requestLanguageServiceHandler(thisHandle: LanguageService): any {
        switch (thisHandle) {
            case LanguageService.FileSystem:
                return this.fsManager;

            case LanguageService.GMLCompletionProvider:
                return this.gmlCompletionProvider;

            case LanguageService.GMLDefinitionProvider:
                return this.gmlDefinitionProvider;

            case LanguageService.GMLHoverProvider:
                return this.gmlHoverProvider;

            case LanguageService.GMLSignatureProvider:
                return this.gmlSignatureProvider;

            case LanguageService.Reference:
                return this.reference;
        }
    }

    private isValidResourceName(name: string) {
        return /^[a-z_]+[a-z0-9_]*$/i.test(name);
    }

    private resourceExistsAlready(name: string) {
        return this.reference.resourceExists(name);
    }

    private async genericResourcePreCheck(newResourceName: string): Promise<boolean> {
        // Basic Check
        if (this.isValidResourceName(newResourceName) === false) {
            this.connection.window.showErrorMessage(
                'Invalid object name given. Resource names should only contain 0-9, a-z, A-Z, or _, and they should not start with 0-9.'
            );
            return false;
        }

        // Check for duplicate resources:
        if (this.resourceExistsAlready(newResourceName)) {
            this.connection.window.showErrorMessage('Invalid script name given. Resource already exists.');
            return false;
        }

        // Make sure our YYP is accurate still
        if ((await this.fsManager.validateYYP(this.connection)) === false) return false;

        return true;
    }

    //#endregion
}
