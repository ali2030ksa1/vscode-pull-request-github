/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TreeNode } from './treeNodes/treeNode';
import { PRCategoryActionNode, CategoryTreeNode, PRCategoryActionType } from './treeNodes/categoryNode';
import { PRType, ITelemetry } from '../github/interface';
import { fromFileChangeNodeUri } from '../common/uri';
import { getInMemPRContentProvider } from './inMemPRContentProvider';
import { PullRequestManager, SETTINGS_NAMESPACE, REMOTES_SETTING } from '../github/pullRequestManager';

interface IQueryInfo {
	label: string;
	query: string;
}

const QUERIES_SETTING = 'queries';

export class PullRequestsTreeDataProvider implements vscode.TreeDataProvider<TreeNode>, vscode.DecorationProvider, vscode.Disposable {
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	get onDidChange(): vscode.Event<vscode.Uri> { return this._onDidChange.event; }
	private _disposables: vscode.Disposable[];
	private _childrenDisposables: vscode.Disposable[];
	private _view: vscode.TreeView<TreeNode>;
	private _prManager: PullRequestManager;
	private _initialized: boolean = false;
	private _queries: IQueryInfo[];

	get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	constructor(
		private _telemetry: ITelemetry
	) {
		this._disposables = [];
		this._disposables.push(vscode.workspace.registerTextDocumentContentProvider('pr', getInMemPRContentProvider()));
		this._disposables.push(vscode.window.registerDecorationProvider(this));
		this._disposables.push(vscode.commands.registerCommand('pr.refreshList', _ => {
			this._onDidChangeTreeData.fire();
		}));

		this._disposables.push(vscode.commands.registerCommand('pr.loadMore', (node: CategoryTreeNode) => {
			node.fetchNextPage = true;
			this._onDidChangeTreeData.fire(node);
		}));

		const treeId = vscode.workspace.getConfiguration('githubPullRequests').get<boolean>('showInSCM') ? 'pr:scm' : 'pr:github';
		this._view = vscode.window.createTreeView(treeId, {
			treeDataProvider: this,
			showCollapseAll: true
		});

		this._disposables.push(this._view);
		this._childrenDisposables = [];

		this._disposables.push(vscode.commands.registerCommand('pr.configurePRViewlet', async () => {
			const configuration = await vscode.window.showQuickPick(['Configure Remotes...', 'Configure Queries...']);

			const { name, publisher } = require('../../package.json') as { name: string, publisher: string };
			const extensionId = `${publisher}.${name}`;

			switch (configuration) {
				case 'Configure Queries...':
					return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId} queries`);
				case 'Configure Remotes...':
					return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId} remotes`);
				default:
					return;
			}
		}));
	}

	initialize(prManager: PullRequestManager) {
		if (this._initialized) {
			throw new Error('Tree has already been initialized!');
		}

		this._initialized = true;
		this._prManager = prManager;
		this.initializeCategories();
		this.refresh();
	}

	public updateQueries() {
		this._queries = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE, this._prManager.repository.rootUri).get<IQueryInfo[]>(QUERIES_SETTING) || [];
	}

	private initializeCategories() {
		this.updateQueries();

		this._disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${SETTINGS_NAMESPACE}.${QUERIES_SETTING}`)) {
				this.updateQueries();
				this.refresh();
			}
		}));
	}

	async refresh(node?: TreeNode) {
		return node ? this._onDidChangeTreeData.fire(node) : this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return element.getTreeItem();
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!this._prManager) {
			if (!vscode.workspace.workspaceFolders) {
				return Promise.resolve([new PRCategoryActionNode(this._view, PRCategoryActionType.NoOpenFolder)]);
			} else {
				return Promise.resolve([new PRCategoryActionNode(this._view, PRCategoryActionType.NoGitRepositories)]);
			}
		}

		if (!this._prManager.getGitHubRemotes().length) {
			const remotesSetting = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string[]>(REMOTES_SETTING);
			if (remotesSetting) {
				return Promise.resolve([
					new PRCategoryActionNode(this._view, PRCategoryActionType.NoMatchingRemotes),
					new PRCategoryActionNode(this._view, PRCategoryActionType.ConfigureRemotes)
				]);
			}

			return Promise.resolve([new PRCategoryActionNode(this._view, PRCategoryActionType.NoRemotes)]);
		}

		if (!element) {
			if (this._childrenDisposables && this._childrenDisposables.length) {
				this._childrenDisposables.forEach(dispose => dispose.dispose());
			}

			const queryCategories = this._queries.map(queryInfo => new CategoryTreeNode(this._view, this._prManager, this._telemetry, PRType.Query, queryInfo.label, queryInfo.query));
			const result = [
				new CategoryTreeNode(this._view, this._prManager, this._telemetry, PRType.LocalPullRequest),
				...queryCategories,
				new CategoryTreeNode(this._view, this._prManager, this._telemetry, PRType.All)
			];

			this._childrenDisposables = result;
			return Promise.resolve(result);
		}
		if (this._prManager.repository.state.remotes.length === 0) {
			return Promise.resolve([new PRCategoryActionNode(this._view, PRCategoryActionType.Empty)]);
		}

		return element.getChildren();
	}

	async getParent(element: TreeNode): Promise<TreeNode | undefined> {
		return element.getParent();
	}

	_onDidChangeDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
	onDidChangeDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeDecorations.event;
	provideDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.DecorationData> {
		let fileChangeUriParams = fromFileChangeNodeUri(uri);
		if (fileChangeUriParams && fileChangeUriParams.hasComments) {
			return {
				bubble: false,
				title: 'Commented',
				letter: '◆',
				priority: 2
			};
		}

		return undefined;
	}

	dispose() {
		this._disposables.forEach(dispose => dispose.dispose());
	}

}
