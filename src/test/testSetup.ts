/*
 * Copyright (c) 2016, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { randomBytes } from 'crypto';
import { forEach, once } from 'lodash';
import chalk from 'chalk';
import { Logger } from '../lib/logger';
import { Messages } from '../lib/messages';
import { Crypto } from '../lib/crypto';
import { Connection } from '../lib/connection';
import { ConfigFile } from '../lib/config/configFile';
import { join as pathJoin } from 'path';
import { tmpdir as osTmpdir } from 'os';
import { ConfigContents } from '../lib/config/configStore';
import { SfdxError } from '../lib/sfdxError';
import { EventEmitter } from 'events';
import { CometClient, CometSubscription } from '../lib/status/streamingClient';
import { AnyJson, JsonMap } from '@salesforce/ts-json';
import * as _ from 'lodash';

/**
 * Different parts of the system that are mocked out. They can be restored for
 * individual tests. Test's stubs should always go on the DEFAULT which is exposed
 * on the TestContext.
 */
export interface SandboxTypes {
    DEFAULT: any; // tslint:disable-line:no-any
    CRYPTO: any; // tslint:disable-line:no-any
    CONFIG: any; // tslint:disable-line:no-any
    CONNECTION: any; // tslint:disable-line:no-any
}

export interface ConfigStub {
    readFn?: () => Promise<ConfigContents>;
    writeFn?: () => Promise<void>;
    // Used for read and write. Useful between config instances
    contents?: object;
    // Useful to override to conditionally get based on the config instance.
    retrieveContents?: () => Promise<object>;
    // Useful to override to conditionally set based on the config instance.
    updateContents?: () => Promise<object>;
}

/**
 * Different configuration options when running before each
 */
export interface TestContext {
    SANDBOX: any; // tslint:disable-line:no-any
    SANDBOXES: SandboxTypes;
    TEST_LOGGER: Logger;
    id: string;
    uniqid: () => string;
    configStubs: { [configName: string]: ConfigStub };
    localPathRetriever: (uid: string) => Promise<string>;
    globalPathRetriever: (uid: string) => Promise<string>;
    rootPathRetriever: (isGlobal: boolean, uid?: string) => Promise<string>;
    fakeConnectionRequest: (request: AnyJson, options?: AnyJson) => Promise<AnyJson>;
}

const _uniqid = () => {
    return randomBytes(16).toString('hex');
};

function getTestLocalPath(uid: string): Promise<string> {
    return Promise.resolve(pathJoin(osTmpdir(), uid, 'sfdx_core', 'local'));
}

function getTestGlobalPath(uid: string): Promise<string> {
    return Promise.resolve(pathJoin(osTmpdir(), uid, 'sfdx_core', 'global'));
}

async function retrieveRootPath(isGlobal: boolean, uid: string = _uniqid()): Promise<string> {
    return isGlobal ? await getTestGlobalPath(uid) : await getTestLocalPath(uid);
}

function defaultFakeConnectionRequest(request: AnyJson, options?: AnyJson): Promise<AnyJson> {
    return Promise.resolve({ records: [] });
}

/**
 * @module testSetup
 */
/**
 * Different hooks into {@link ConfigFile} used for testing instead of doing file IO.
 * @typedef {object} TestContext
 * @property {function} readFn A function `() => Promise<ConfigContents>;` that controls
 * all aspect of {@link ConfigFile.read}. For example, it won't set the contents unless
 * explicitly done. Only use this if you know what you are doing. Use retrieveContents
 * instead.
 * @property {function} writeFn A function `() => Promise<void>;` that controls all aspects
 * of {@link ConfigFile.write}. For example, it won't read the contents unless explicitly
 * done. Only use this if you know what you are doing. Use updateContents instead.
 * @property {object} contents The contents that are used when @{link ConfigFile.read} unless
 * retrieveContents is set. This will also contain the new config when @{link ConfigFile.write}
 * is called. This will persist through config instances, such as {@link Alias.update} and
 * {@link Alias.fetch}.
 * @property {function} retrieveContents A function `() => Promise<object>;` to conditionally
 * read based on the config instance. The `this` value will be the config instance.
 * @property {function} updateContents A function `() => Promise<object>;` to conditionally
 * set based on the config instance. The `this` value will be the config instance.
 */
/**
 * Different configuration options when running before each.
 * @typedef {object} TestContext
 * @property {sinon.sandbox} SANDBOX The default sandbox is cleared out before
 * each test run. See [sinon sandbox]{@link http://sinonjs.org/releases/v1.17.7/sandbox/}.
 * @property {SandboxTypes} SANDBOXES An object of different sandboxes. Used when
 * needing to restore parts of the system for customized testing.
 * @property {Logger} TEST_LOGGER The test logger that is used when {@link Logger.child}
 * is used anywhere. It uses memory logging.
 * @property {string} id A unique id for the test run.
 * @property {function} uniqid A function `() => string` that returns unique strings.
 * @property {object} configStubs An object of `[configName: string]: ConfigStub` used in test that interact with config files.
 * names to {@link ConfigStubs} that contain properties used when reading and writing
 * to config files.
 * @property {function} localPathRetriever A function `(uid: string) => Promise<string>;`
 * used when resolving the local path.
 * @property {function} globalPathRetriever A function `(uid: string) => Promise<string>;`
 * used when resolving the global path.
 * @property {function} rootPathRetriever: A function `(isGlobal: boolean, uid?: string) => Promise<string>;`
 * used then resolving paths. Calls localPathRetriever and globalPathRetriever.
 */

/**
 * Use to mock out different pieces of sfdx-core to make testing easier. This will mock out
 * logging to a file, config file reading and writing, local and global path resolution, and
 * *http request using connection (soon)*.
 * @function testSetup
 * @returns {TestContext}
 *
 * @example
 * // In a mocha tests
 * import testSetup from '@salesforce/core/dist/test';
 *
 * const $$ = testSetup();
 *
 * describe(() => {
 *  it('test', () => {
 *    // Stub out your own method
 *    $$.SANDBOX.stub(MyClass.prototype, 'myMethod').returnsFake(() => {});
 *
 *    // Set the contents that is used when aliases are read. Same for all config files.
 *    $$.configStubs['Aliases'].content = { 'myTestAlias': 'user@company.com' };
 *
 *    // Will use the contents set above.
 *    const username = Aliases.fetch('myTestAlias');
 *    expect(username).to.equal('user@company.com');
 *  });
 * });
 */
export const testSetup = once((sinon?) => {
    if (!sinon) {
        try {
            sinon = require('sinon');
        } catch (e) {
            throw new Error('The package sinon was not found. Add it to your package.json and pass it in to testSetup(sinon.sandbox)');
        }
    }

    // Import all the messages files in the sfdx-core messages dir.
    // Messages.importMessagesDirectory(pathJoin(__dirname, '..', '..'));
    Messages.importMessagesDirectory(pathJoin(__dirname));
    // Create a global sinon sandbox and a test logger instance for use within tests.
    const defaultSandbox = sinon.createSandbox();
    const testContext: TestContext = {
        SANDBOX: defaultSandbox,
        SANDBOXES: {
            DEFAULT: defaultSandbox,
            CONFIG: sinon.createSandbox(),
            CRYPTO: sinon.createSandbox(),
            CONNECTION: sinon.createSandbox()
        },
        TEST_LOGGER: new Logger({ name: 'SFDX_Core_Test_Logger' }).useMemoryLogging(),
        id: _uniqid(),
        uniqid: _uniqid,
        configStubs: {},
        localPathRetriever: getTestLocalPath,
        globalPathRetriever: getTestGlobalPath,
        rootPathRetriever: retrieveRootPath,
        fakeConnectionRequest: defaultFakeConnectionRequest
    };

    const chalkEnabled = chalk.enabled;

    beforeEach(() => {
        // Most core files create a child logger so stub this to return our test logger.
        testContext.SANDBOX.stub(Logger, 'child').returns(Promise.resolve(testContext.TEST_LOGGER));

        testContext.SANDBOXES.CONFIG.stub(ConfigFile, 'resolveRootFolder').callsFake((isGlobal) => testContext.rootPathRetriever(isGlobal, testContext.id));

        // Mock out all config file IO for all tests. They can restore individually if they need original functionality.
        testContext.SANDBOXES.CONFIG.stub(ConfigFile.prototype, 'read').callsFake(async function() {
            const stub = testContext.configStubs[this.constructor.name] || {};

            if (stub.readFn) {
                return await stub.readFn.call(this);
            }

            let contents = stub.contents || {};
            if (stub.retrieveContents) {
                contents = await stub.retrieveContents.call(this);
            }

            this.setContentsFromObject(contents);
            return Promise.resolve(this.getContents());
        });
        testContext.SANDBOXES.CONFIG.stub(ConfigFile.prototype, 'write').callsFake(async function(newContents) {
            if (!testContext.configStubs[this.constructor.name]) {
                testContext.configStubs[this.constructor.name] = {};
            }
            const stub =  testContext.configStubs[this.constructor.name];

            if (stub.writeFn) {
                return await stub.writeFn.call(this, newContents);
            }

            let contents = newContents || this.getContents();

            if (stub.updateContents) {
                contents = await stub.updateContents.call(this);
            }
            this.setContents(contents);
            testContext.configStubs[this.constructor.name].contents = this.toObject();
            return Promise.resolve();
        });

        testContext.SANDBOXES.CRYPTO.stub(Crypto.prototype, 'getKeyChain').callsFake(() => Promise.resolve({
            setPassword: () => Promise.resolve(),
            getPassword: (data, cb) => cb(undefined, '12345678901234567890123456789012')
        }));

        testContext.SANDBOXES.CONNECTION.stub(Connection.prototype, 'request').callsFake(function(request, options?) {
            if (request === `${this.instanceUrl}/services/data`) {
                return Promise.resolve([{ version: '42.0' }]);
            }
            return testContext.fakeConnectionRequest.call(this, request, options);
        });

        chalk.enabled = false;
    });

    afterEach(() => {
        testContext.SANDBOX.restore();
        forEach(testContext.SANDBOXES, (theSandbox) => theSandbox.restore());
        testContext.configStubs = {};
        chalk.enabled = chalkEnabled;
    });

    return testContext;
});

/**
 * A pre-canned error for try/catch testing.
 * @see shouldThrowAsync
 * @type {SfdxError}
 */
export const unexpectedResult: SfdxError = new SfdxError('This code was expected to failed',
    'UnexpectedResult');

/**
 * Use for this testing pattern:
 *
 *  try {
 *      await call()
 *      assert.fail('this should never happen');
 *  } catch (e) {
 *  ...
 *  }
 *
 *  Just do this
 *
 *  try {
 *      shouldThrowAsync(call()); // If this succeeds unexpectedResultError is thrown.
 *  } catch(e) {
 *  ...
 *  }
 *
 * @param {Promise<AnyJson>} f The async function that is expected to throw.
 * @returns {Promise<void>}
 */
export async function shouldThrowAsync(f: Promise<any>) {// tslint:disable-line:no-any
    return Promise.resolve(f).then(() => {
        throw unexpectedResult;
    });
}

/**
 * A helper to determine if a subscription will use callback or errorback.
 * Enable errback to simulate a subscription failure.
 */
export enum StreamingMockSubscriptionCall {
    CALLBACK,
    ERRORBACK
}

/**
 * Additional subscription options for the StreamingMock.
 */
export interface StreamingMockCometSubscriptionOptions {
    // Target URL
    url: string;
    // Simple id to associate with this instance.
    id: string;
    // What is the subscription outcome a successful callback or an error?
    subscriptionCall: StreamingMockSubscriptionCall;
    // If it's an error that states what that error should be.
    subscriptionErrbackError?: SfdxError;
    // A list of messages to playback for the client. One message per process tick.
    messagePlaylist?: JsonMap[];
}

/**
 * Simulates a comet subscription to a streaming channel.
 */
export class StreamingMockCometSubscription extends EventEmitter implements CometSubscription {
    public static SUBSCRIPTION_COMPLETE: string = 'subscriptionComplete';
    public static SUBSCRIPTION_FAILED: string = 'subscriptionFailed';
    private options: StreamingMockCometSubscriptionOptions;

    constructor(options: StreamingMockCometSubscriptionOptions) {
        super();
        this.options = options;
    }

    public callback(callback: () => void): void {
        if (this.options.subscriptionCall === StreamingMockSubscriptionCall.CALLBACK) {
            setTimeout(() => {
                callback();
                super.emit(StreamingMockCometSubscription.SUBSCRIPTION_COMPLETE);
            }, 0);
        }
    }

    public errback(callback: (error: Error) => void): void {
        if (this.options.subscriptionCall === StreamingMockSubscriptionCall.ERRORBACK) {
            setTimeout(() => {
                callback(this.options.subscriptionErrbackError);
                super.emit(StreamingMockCometSubscription.SUBSCRIPTION_FAILED);
            }, 0);
        }
    }
}

/**
 * Simulates a comet client. To the core streaming client this mocks the internal comet impl.
 * The uses setTimeout(0ms) event loop phase just so the client can simulate actual streaming without the response
 * latency.
 */
export class StreamingMockCometClient extends CometClient {
    private readonly options: StreamingMockCometSubscriptionOptions;

    /**
     * Constructor
     * @param {StreamingMockCometSubscriptionOptions} options Extends the StreamingClient options.
     */
    constructor(options: StreamingMockCometSubscriptionOptions) {
        super(options.url);
        this.options = options;
        if (!this.options.messagePlaylist) {
            this.options.messagePlaylist = [{ id:  this.options.id }];
        }
    }

    public addExtension(extension: JsonMap): void {}

    public disable(label: string): void {}

    public handshake(callback: () => void): void {
        setTimeout(() => { callback(); }, 0);
    }

    public setHeader(name: string, value: string): void {}

    public subscribe(channel: string, callback: (message: JsonMap) => void): CometSubscription {
        const subscription: StreamingMockCometSubscription = new StreamingMockCometSubscription(this.options);
        subscription.on('subscriptionComplete', () => {
            _.each(this.options.messagePlaylist, (message) => {
                setTimeout(() => {
                    callback(message);
                }, 0);
            });
        });
        return subscription;
    }

    public disconnect(): Promise<void> {
        return Promise.resolve();
    }
}
