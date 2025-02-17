import assert = require('assert');
import Octokit = require('@octokit/rest');
import * as utils from '../../common/utils';
import { EventEmitter } from 'vscode';

describe('utils', () => {
	describe('formatError', () => {
		it('should format a normal error', () => {
			const error = new Error('No!');
			assert.equal(utils.formatError(error), 'No!');
		});

		it('should format an HttpError from octorest', (done) => {
			const octokit = new Octokit();
			octokit.pulls.listComments({
				number: 1,
				owner: 'me',
				repo: '犬?'
			}).then((_: any) => {
				assert.fail('managed the impossible');
				done();
			}).catch((e: any) => {
				assert.equal(utils.formatError(e), 'Not Found');
				done();
			});
		});

		it('should format an error with submessages', () => {
			const error = new Error(`{"message":"Validation Failed","errors":[{"resource":"PullRequestReview","code":"custom","field":"user_id","message":"user_id can only have one pending review per pull request"}],"documentation_url":"https://developer.github.com/v3/pulls/comments/#create-a-comment"}`);
			assert.equal(utils.formatError(error), 'Validation Failed: user_id can only have one pending review per pull request');
		});

		it('should format an error with submessages that are strings', () => {
			const error = new Error(`{"message":"Validation Failed","errors":["Can not approve your own pull request"],"documentation_url":"https://developer.github.com/v3/pulls/reviews/#create-a-pull-request-review"}`);
			assert.equal(utils.formatError(error), 'Validation Failed: Can not approve your own pull request');
		});
	});

	describe('promiseFromEvent', () => {
		const hasListeners = (emitter: any) =>
			!emitter._listeners!.isEmpty();

		describe('without arguments', () => {
			it('should return a promise for the next event', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event);
				emitter.fire('hello');
				emitter.fire('world');
				const value = await promise;
				assert.equal(value, 'hello');
			});

			it('should unsubscribe after the promise resolves', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event);
				assert(hasListeners(emitter), 'should subscribe');
				emitter.fire('hello');
				await promise;
				assert(!hasListeners(emitter), 'should unsubscribe');
			});
		});

		describe('with an adapter', () => {
			const count: utils.PromiseAdapter<string, number> =
				(str, resolve, reject) =>
					str.length <= 4
						? resolve(str.length)
						: reject(new Error('the string is too damn long'));

			it('should return a promise that uses the adapter\'s value', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event, count);
				assert(hasListeners(emitter), 'should subscribe');
				emitter.fire('hell');
				const value = await promise;
				assert(!hasListeners(emitter), 'should unsubscribe');
				assert.equal(value, 'hell'.length);
			});

			it('should return a promise that rejects if the adapter does', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event, count);
				assert(hasListeners(emitter), 'should subscribe');
				emitter.fire('hello');
				await promise
					.then(
						() => { throw new Error('promise should have rejected'); },
						e => assert.equal(e.message, 'the string is too damn long')
					);
				assert(!hasListeners(emitter), 'should unsubscribe');
			});

			it('should return a promise that rejects if the adapter throws', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(
					emitter.event,
					() => { throw new Error('kaboom'); }
				);
				assert(hasListeners(emitter), 'should subscribe');
				emitter.fire('hello');
				await promise
					.then(
						() => { throw new Error('promise should have rejected'); },
						e => assert.equal(e.message, 'kaboom')
					);
				assert(!hasListeners(emitter), 'should unsubscribe');
			});

			it('should return a promise that rejects if the adapter returns a rejecting Promise', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(
					emitter.event,
					async () => { throw new Error('kaboom'); }
				);
				assert(hasListeners(emitter), 'should subscribe');
				emitter.fire('hello');
				await promise
					.then(
						() => { throw new Error('promise should have rejected'); },
						e => assert.equal(e.message, 'kaboom')
					);
				assert(!hasListeners(emitter), 'should unsubscribe');
			});

			const door: utils.PromiseAdapter<string, boolean> =
				(password, resolve, reject) =>
					password === 'sesame'
						? resolve(true)
						:
					password === 'mellon'
						? reject(new Error('wrong fable'))
						:
						{/* the door is silent */};

			const tick = () => new Promise(resolve => setImmediate(resolve));
			it('should stay subscribed until the adapter resolves', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event, door);
				let hasResolved = false; promise.then(() => hasResolved = true);
				emitter.fire('password');
				emitter.fire('12345');
				await tick();
				assert.equal(hasResolved, false, 'shouldn\'t have resolved yet');
				assert(hasListeners(emitter), 'should still be listening');
				emitter.fire('sesame');
				await tick();
				assert.equal(hasResolved, true, 'should have resolved');
				assert(!hasListeners(emitter), 'should have unsubscribed');
			});

			it('should stay subscribed until the adapter rejects', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event, door);
				let hasResolved = false, hasRejected = false;
				promise.then(() => hasResolved = true, () => hasRejected = true);
				emitter.fire('password');
				emitter.fire('12345');
				await tick();
				assert.equal(hasResolved, false, 'shouldn\'t resolve');
				assert.equal(hasRejected, false, 'shouldn\'t have rejected yet');
				assert(hasListeners(emitter), 'should still be listening');
				emitter.fire('mellon');
				await tick();
				assert.equal(hasResolved, false, 'shouldn\'t resolve');
				assert.equal(hasRejected, true, 'should have rejected');
				assert(!hasListeners(emitter), 'should have unsubscribed');
			});
		});
	});
});