/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as Octokit from '@octokit/rest';
import * as vscode from 'vscode';
import { IAccount, PullRequest, IGitHubRef } from './interface';
import { Comment, Reaction } from '../common/comment';
import { parseDiffHunk, DiffHunk } from '../common/diffHunk';
import * as Common from '../common/timelineEvent';
import * as GraphQL from './graphql';
import { Resource } from '../common/resources';
import { PullRequestModel } from './pullRequestModel';
import { getEditCommand, getDeleteCommand, getAcceptInputCommands } from './commands';
import { PRNode } from '../view/treeNodes/pullRequestNode';
import { ReviewDocumentCommentProvider } from '../view/reviewDocumentCommentProvider';
import { uniqBy } from '../common/utils';
import { GitHubRepository } from './githubRepository';

export interface CommentHandler {
	commentController?: vscode.CommentController;
	startReview(thread: vscode.CommentThread): Promise<void>;
	finishReview(thread: vscode.CommentThread): Promise<void>;
	deleteReview(): Promise<void>;
	createOrReplyComment(thread: vscode.CommentThread): Promise<void>;
	editComment(thread: vscode.CommentThread, comment: vscode.Comment): Promise<void>;
	deleteComment(thread: vscode.CommentThread, comment: vscode.Comment): Promise<void>;
}

export function convertToVSCodeComment(comment: Comment, command: vscode.Command | undefined): vscode.Comment & { _rawComment: Comment } {
	let vscodeComment: vscode.Comment & { _rawComment: Comment } = {
		_rawComment: comment,
		commentId: comment.id.toString(),
		body: new vscode.MarkdownString(comment.body),
		selectCommand: command,
		userName: comment.user!.login,
		userIconPath: comment.user && comment.user.avatarUrl ? vscode.Uri.parse(comment.user.avatarUrl) : undefined,
		label: !!comment.isDraft ? 'Pending' : undefined,
		commentReactions: comment.reactions ? comment.reactions.map(reaction => {
			return { label: reaction.label, hasReacted: reaction.viewerHasReacted, count: reaction.count, iconPath: reaction.icon };
		}) : []
	};

	return vscodeComment;
}

export function createVSCodeCommentThread(thread: vscode.CommentThread, commentController: vscode.CommentController, pullRequestModel: PullRequestModel, inDraftMode: boolean, node: PRNode | ReviewDocumentCommentProvider) {
	let vscodeThread = commentController.createCommentThread(
		thread.threadId,
		thread.resource,
		thread.range!,
		thread.comments
	);

	vscodeThread.comments = thread.comments.map(comment => {
		updateCommentCommands(comment, commentController, vscodeThread, pullRequestModel, node);
		return comment;
	});

	updateCommentThreadLabel(vscodeThread);

	let commands = getAcceptInputCommands(vscodeThread, inDraftMode, node, pullRequestModel.githubRepository.supportsGraphQl);
	vscodeThread.acceptInputCommand = commands.acceptInputCommand;
	vscodeThread.additionalCommands = commands.additionalCommands;
	vscodeThread.collapsibleState = thread.collapsibleState;
	return vscodeThread;
}

export function updateCommentThreadLabel(thread: vscode.CommentThread) {
	if (thread.comments.length) {
		const participantsList = uniqBy(thread.comments as vscode.Comment[], comment => comment.userName).map(comment => `@${comment.userName}`).join(', ');
		thread.label = `Participants: ${participantsList}`;
	} else {
		thread.label = 'Start discussion';
	}
}

export function updateCommentReactions(comment: vscode.Comment, reactions: Reaction[]) {
	comment.commentReactions = reactions.map(ret => {
		return { label: ret.label, hasReacted: ret.viewerHasReacted, count: ret.count, iconPath: ret.icon };
	});
}

export function updateCommentReviewState(thread: vscode.CommentThread, newDraftMode: boolean) {
	if (newDraftMode) {
		return;
	}

	thread.comments = thread.comments.map(comment => {
		let patchedComment = comment as (vscode.Comment & { _rawComment: Comment });
		patchedComment._rawComment.isDraft = false;
		patchedComment.label = undefined;

		return patchedComment;
	});
}

export function updateCommentCommands(vscodeComment: vscode.Comment, commentControl: vscode.CommentController, thread: vscode.CommentThread, pullRequestModel: PullRequestModel, node: PRNode | ReviewDocumentCommentProvider) {
	if (commentControl && pullRequestModel) {
		let patchedComment = vscodeComment as vscode.Comment & { _rawComment: Comment, canEdit?: boolean, canDelete?: boolean, isDraft?: boolean };

		if (patchedComment._rawComment.canEdit) {
			patchedComment.editCommand = getEditCommand(thread, vscodeComment, node);
		}

		if (patchedComment._rawComment.canDelete) {
			patchedComment.deleteCommand = getDeleteCommand(thread, vscodeComment, node);
		}
	}
}

export function convertRESTUserToAccount(user: Octokit.PullsListResponseItemUser, githubRepository: GitHubRepository): IAccount {
	return {
		login: user.login,
		url: user.html_url,
		avatarUrl: githubRepository.isGitHubDotCom ? user.avatar_url : undefined
	};
}

export function convertRESTHeadToIGitHubRef(head: Octokit.PullsListResponseItemHead) {
	return {
		label: head.label,
		ref: head.ref,
		sha: head.sha,
		repo: { cloneUrl: head.repo.clone_url }
	};
}

export function convertRESTPullRequestToRawPullRequest(pullRequest: Octokit.PullsCreateResponse | Octokit.PullsGetResponse | Octokit.PullsListResponseItem, githubRepository: GitHubRepository): PullRequest {
	let {
		number,
		body,
		title,
		html_url,
		user,
		state,
		assignee,
		created_at,
		updated_at,
		head,
		base,
		labels,
		node_id,
		id,
		draft
	} = pullRequest;

	const item: PullRequest = {
			id,
			graphNodeId: node_id,
			number,
			body,
			title,
			url: html_url,
			user: convertRESTUserToAccount(user, githubRepository),
			state,
			merged: (pullRequest as Octokit.PullsGetResponse).merged || false,
			assignee: assignee ? convertRESTUserToAccount(assignee, githubRepository) : undefined,
			createdAt: created_at,
			updatedAt: updated_at,
			head: convertRESTHeadToIGitHubRef(head),
			base: convertRESTHeadToIGitHubRef(base),
			mergeable: (pullRequest as Octokit.PullsGetResponse).mergeable,
			labels,
			isDraft: draft
	};

	return item;
}

export function convertRESTReviewEvent(review: Octokit.PullsCreateReviewResponse, githubRepository: GitHubRepository): Common.ReviewEvent {
	return {
		event: Common.EventType.Reviewed,
		comments: [],
		submittedAt: (review as any).submitted_at, // TODO fix typings upstream
		body: review.body,
		htmlUrl: review.html_url,
		user: convertRESTUserToAccount(review.user, githubRepository),
		authorAssociation: review.user.type,
		state: review.state as 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'PENDING',
		id: review.id
	};
}

export function parseCommentDiffHunk(comment: Comment): DiffHunk[] {
	let diffHunks = [];
	let diffHunkReader = parseDiffHunk(comment.diffHunk);
	let diffHunkIter = diffHunkReader.next();

	while (!diffHunkIter.done) {
		let diffHunk = diffHunkIter.value;
		diffHunks.push(diffHunk);
		diffHunkIter = diffHunkReader.next();
	}

	return diffHunks;
}

export function convertIssuesCreateCommentResponseToComment(comment: Octokit.IssuesCreateCommentResponse | Octokit.IssuesUpdateCommentResponse, githubRepository: GitHubRepository): Comment {
	return {
		url: comment.url,
		id: comment.id,
		diffHunk: '',
		diffHunks: [],
		path: undefined,
		position: undefined,
		commitId: undefined,
		originalPosition: undefined,
		originalCommitId: undefined,
		user: convertRESTUserToAccount(comment.user, githubRepository),
		body: comment.body,
		createdAt: comment.created_at,
		htmlUrl: comment.html_url,
		graphNodeId: comment.node_id
	};
}

export function convertPullRequestsGetCommentsResponseItemToComment(comment: Octokit.PullsListCommentsResponseItem | Octokit.PullsUpdateCommentResponse, githubRepository: GitHubRepository): Comment {
	let ret: Comment = {
		url: comment.url,
		id: comment.id,
		pullRequestReviewId: comment.pull_request_review_id,
		diffHunk: comment.diff_hunk,
		path: comment.path,
		position: comment.position,
		commitId: comment.commit_id,
		originalPosition: comment.original_position,
		originalCommitId: comment.original_commit_id,
		user: convertRESTUserToAccount(comment.user, githubRepository),
		body: comment.body,
		createdAt: comment.created_at,
		htmlUrl: comment.html_url,
		inReplyToId: comment.in_reply_to_id,
		graphNodeId: comment.node_id
	};

	let diffHunks = parseCommentDiffHunk(ret);
	ret.diffHunks = diffHunks;
	return ret;
}

export function convertGraphQLEventType(text: string) {
	switch (text) {
		case 'Commit':
			return Common.EventType.Committed;
		case 'LabeledEvent':
			return Common.EventType.Labeled;
		case 'MilestonedEvent':
			return Common.EventType.Milestoned;
		case 'AssignedEvent':
			return Common.EventType.Assigned;
		case 'IssueComment':
			return Common.EventType.Commented;
		case 'PullRequestReview':
			return Common.EventType.Reviewed;
		case 'MergedEvent':
			return Common.EventType.Merged;

		default:
			return Common.EventType.Other;
	}
}

export function parseGraphQLComment(comment: GraphQL.ReviewComment): Comment {
	const c: Comment = {
		id: comment.databaseId,
		url: comment.url,
		body: comment.body,
		path: comment.path,
		canEdit: comment.viewerCanDelete,
		canDelete: comment.viewerCanDelete,
		pullRequestReviewId: comment.pullRequestReview && comment.pullRequestReview.databaseId,
		diffHunk: comment.diffHunk,
		position: comment.position,
		commitId: comment.commit.oid,
		originalPosition: comment.originalPosition,
		originalCommitId: comment.originalCommit && comment.originalCommit.oid,
		user: comment.author,
		createdAt: comment.createdAt,
		htmlUrl: comment.url,
		graphNodeId: comment.id,
		isDraft: comment.state === 'PENDING',
		inReplyToId: comment.replyTo && comment.replyTo.databaseId,
		reactions: parseGraphQLReaction(comment.reactionGroups)
	};

	const diffHunks = parseCommentDiffHunk(c);
	c.diffHunks = diffHunks;

	return c;
}

export function parseGraphQLReaction(reactionGroups: GraphQL.ReactionGroup[]): Reaction[] {
	let reactionConentEmojiMapping = getReactionGroup().reduce((prev, curr) => {
		prev[curr.title] = curr;
		return prev;
	}, {} as { [key:string] : { title: string; label: string; icon?: vscode.Uri } });

	const reactions = reactionGroups.filter(group => group.users.totalCount > 0).map(group => {
		const reaction: Reaction = {
			label: reactionConentEmojiMapping[group.content].label,
			count: group.users.totalCount,
			icon: reactionConentEmojiMapping[group.content].icon,
			viewerHasReacted: group.viewerHasReacted
		};

		return reaction;
	});

	return reactions;
}

function parseRef(ref: GraphQL.Ref | undefined): IGitHubRef | undefined {
	if (ref) {
		return {
			label: `${ref.repository.owner.login}:${ref.name}`,
			ref: ref.name,
			sha: ref.target.oid,
			repo: {
				cloneUrl: ref.repository.url
			}
		};
	}
}

function parseAuthor(author: {login: string, url: string, avatarUrl: string}, githubRepository: GitHubRepository): IAccount {
	return {
		login: author.login,
		url: author.url,
		avatarUrl: githubRepository.isGitHubDotCom ? author.avatarUrl : undefined
	};
}

export function parseGraphQLPullRequest(pullRequest: GraphQL.PullRequestResponse, githubRepository: GitHubRepository): PullRequest {
	const graphQLPullRequest = pullRequest.repository.pullRequest;

	return {
		id: graphQLPullRequest.databaseId,
		graphNodeId: graphQLPullRequest.id,
		url: graphQLPullRequest.url,
		number: graphQLPullRequest.number,
		state: graphQLPullRequest.state,
		body: graphQLPullRequest.body,
		bodyHTML: graphQLPullRequest.bodyHTML,
		title: graphQLPullRequest.title,
		createdAt: graphQLPullRequest.createdAt,
		updatedAt: graphQLPullRequest.updatedAt,
		head: parseRef(graphQLPullRequest.headRef),
		base: parseRef(graphQLPullRequest.baseRef),
		user: parseAuthor(graphQLPullRequest.author, githubRepository),
		merged: graphQLPullRequest.merged,
		mergeable: graphQLPullRequest.mergeable === 'MERGEABLE',
		labels: graphQLPullRequest.labels.nodes,
		isDraft: graphQLPullRequest.isDraft
	};
}

export function parseGraphQLReviewEvent(review: GraphQL.SubmittedReview, githubRepository: GitHubRepository): Common.ReviewEvent {
	return {
		event: Common.EventType.Reviewed,
		comments: review.comments.nodes.map(parseGraphQLComment).filter(c => !c.inReplyToId),
		submittedAt: review.submittedAt,
		body: review.body,
		bodyHTML: review.bodyHTML,
		htmlUrl: review.url,
		user: parseAuthor(review.author, githubRepository),
		authorAssociation: review.authorAssociation,
		state: review.state,
		id: review.databaseId
	};
}

export function parseGraphQLTimelineEvents(events: (GraphQL.MergedEvent | GraphQL.Review | GraphQL.IssueComment | GraphQL.Commit | GraphQL.AssignedEvent)[], githubRepository: GitHubRepository): Common.TimelineEvent[] {
	const normalizedEvents: Common.TimelineEvent[] = [];
	events.forEach(event => {
		let type = convertGraphQLEventType(event.__typename);

		switch (type) {
			case Common.EventType.Commented:
				let commentEvent = event as GraphQL.IssueComment;
				normalizedEvents.push({
					htmlUrl: commentEvent.url,
					body: commentEvent.body,
					bodyHTML: commentEvent.bodyHTML,
					user: parseAuthor(commentEvent.author, githubRepository),
					event: type,
					canEdit: commentEvent.viewerCanUpdate,
					canDelete: commentEvent.viewerCanDelete,
					id: commentEvent.databaseId,
					createdAt: commentEvent.createdAt
				});
				return;
			case Common.EventType.Reviewed:
				let reviewEvent = event as GraphQL.Review;
				normalizedEvents.push({
					event: type,
					comments: [],
					submittedAt: reviewEvent.submittedAt,
					body: reviewEvent.body,
					bodyHTML: reviewEvent.bodyHTML,
					htmlUrl: reviewEvent.url,
					user: parseAuthor(reviewEvent.author, githubRepository),
					authorAssociation: reviewEvent.authorAssociation,
					state: reviewEvent.state,
					id: reviewEvent.databaseId,
				});
				return;
			case Common.EventType.Committed:
				let commitEv = event as GraphQL.Commit;
				normalizedEvents.push({
					id: commitEv.databaseId,
					event: type,
					sha: commitEv.oid,
					author: commitEv.author.user ? parseAuthor(commitEv.author.user, githubRepository) : { login: commitEv.committer.name },
					htmlUrl: commitEv.url,
					message: commitEv.message
				} as Common.CommitEvent); // TODO remove cast
				return;
			case Common.EventType.Merged:
				let mergeEv = event as GraphQL.MergedEvent;

				normalizedEvents.push({
					id: mergeEv.databaseId,
					event: type,
					user: parseAuthor(mergeEv.actor, githubRepository),
					createdAt: mergeEv.createdAt,
					mergeRef: mergeEv.mergeRef.name,
					sha: mergeEv.commit.oid,
					commitUrl: mergeEv.commit.commitUrl,
					url: mergeEv.url,
					graphNodeId: mergeEv.id
				});
				return;
			case Common.EventType.Assigned:
				let assignEv = event as GraphQL.AssignedEvent;

				normalizedEvents.push({
					id: assignEv.databaseId,
					event: type,
					user: assignEv.user,
					actor: assignEv.actor
				});
				return;
			default:
				break;
		}
	});

	return normalizedEvents;
}

export function convertRESTTimelineEvents(events: any[]): Common.TimelineEvent[] {
	events.forEach(event => {
		if (event.event === Common.EventType.Commented) {

		}

		if (event.event === Common.EventType.Reviewed) {
			event.submittedAt = event.submitted_at;
			event.htmlUrl = event.html_url;
			event.authorAssociation = event.user.type;
		}

		if (event.event === Common.EventType.Committed) {
			event.htmlUrl = event.html_url;
		}
	});

	return events;
}

export function getReactionGroup(): { title: string; label: string; icon?: vscode.Uri }[] {
	let ret = [
		{
			title: 'CONFUSED',
			label: '😕',
			icon: Resource.icons.reactions.CONFUSED
		}, {
			title: 'EYES',
			label: '👀',
			icon: Resource.icons.reactions.EYES
		}, {
			title: 'HEART',
			label: '❤️',
			icon: Resource.icons.reactions.HEART
		}, {
			title: 'HOORAY',
			label: '🎉',
			icon: Resource.icons.reactions.HOORAY
		}, {
			title: 'LAUGH',
			label: '😄',
			icon: Resource.icons.reactions.LAUGH
		}, {
			title: 'ROCKET',
			label: '🚀',
			icon: Resource.icons.reactions.ROCKET
		}, {
			title: 'THUMBS_DOWN',
			label: '👎',
			icon: Resource.icons.reactions.THUMBS_DOWN
		}, {
			title: 'THUMBS_UP',
			label: '👍',
			icon: Resource.icons.reactions.THUMBS_UP
		}
	];

	return ret;
}

export function getRelatedUsersFromTimelineEvents(timelineEvents: Common.TimelineEvent[]): { login: string; name: string; }[] {
	let ret: { login: string; name: string; }[] = [];

	timelineEvents.forEach(event => {
		if (Common.isCommitEvent(event)) {
			ret.push({
				login: event.author.login,
				name: event.author.name || ''
			});
		}

		if (Common.isReviewEvent(event)) {
			ret.push({
				login: event.user.login,
				name: event.user.login
			});
		}

		if (Common.isCommentEvent(event)) {
			ret.push({
				login: event.user.login,
				name: event.user.login
			});
		}
	});

	return ret;
}