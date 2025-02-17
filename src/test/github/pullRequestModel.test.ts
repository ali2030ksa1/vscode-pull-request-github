import assert = require('assert');
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { CredentialStore } from '../../github/credentials';
import { GitHubRepository } from '../../github/githubRepository';
import { PullRequestModel } from '../../github/pullRequestModel';
import { PullRequestStateEnum } from '../../github/interface';
import { Protocol } from '../../common/protocol';
import { Remote } from '../../common/remote';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { SinonSandbox, createSandbox } from 'sinon';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';

const telemetry = {
	on: (action: string) => Promise.resolve(),
	shutdown: () => Promise.resolve()
};
const protocol = new Protocol('https://github.com/github/test.git');
const remote = new Remote('test', 'github/test', protocol);

describe('PullRequestModel', function () {
	let sinon: SinonSandbox;
	let credentials: CredentialStore;
	let repo: GitHubRepository;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		credentials = new CredentialStore(telemetry);
		repo = new GitHubRepository(remote, credentials);
	});

	afterEach(function () {
		credentials.dispose();
		sinon.restore();
	});

	it('should return `state` properly as `open`', function () {
		const pr = new PullRequestBuilder().state('open').build();
		const open = new PullRequestModel(repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));

		assert.equal(open.state, PullRequestStateEnum.Open);
	});

	it('should return `state` properly as `closed`', function () {
		const pr = new PullRequestBuilder().state('closed').build();
		const open = new PullRequestModel(repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));

		assert.equal(open.state, PullRequestStateEnum.Closed);
	});

	it('should return `state` properly as `merged`', function () {
		const pr = new PullRequestBuilder().merged(true).state('closed').build();
		const open = new PullRequestModel(repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));

		assert.equal(open.state, PullRequestStateEnum.Merged);
	});
});
