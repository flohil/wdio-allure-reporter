import events from 'events'
import Allure from 'allure-js-commons'
import Step from 'allure-js-commons/beans/step'
import * as fs from 'fs'

function isEmpty (object) {
    return !object || Object.keys(object).length === 0
}

const LOGGING_HOOKS = ['"before all" hook', '"after all" hook']

let debug = false
let debugSeleniumCommand = false

function logger () {
    if (debug) {
        console.log(arguments)
    }
}
function error () {
    console.error(arguments)
}

/**
 * Initialize a new `Allure` test reporter.
 *
 * @param {Runner} runner
 * @api public
 */
class AllureReporter extends events.EventEmitter {
    constructor (baseReporter, config, options = {}) {
        super()

        this.baseReporter = baseReporter
        this.config = config
        this.options = options
        if (options) {
            debug = options.debug
            debugSeleniumCommand = options.debugSeleniumCommand
        }
        this.allures = {}
        const { epilogue } = this.baseReporter

        this.on('end', () => {
            epilogue.call(baseReporter)
        })

        this.on('suite:start', (suite) => {
            const allure = this.getAllure(suite.cid)
            const currentSuite = allure.getCurrentSuite()
            const prefix = currentSuite ? currentSuite.name + ' ' : ''

            process.workflo.currentCid = suite.cid

            allure.startSuite(prefix + suite.title)
        })

        this.on('suite:end', (suite) => {
            this.getAllure(suite.cid).endSuite()
        })

        this.on('test:start', (test) => {
            const allure = this.getAllure(test.cid)
            allure.startCase(test.title)

            const currentTest = allure.getCurrentTest()

            if (test.testcase) {
                currentTest.addParameter('argument', 'Testcase', test.testcase)
            } else if (test.spec) {
                currentTest.addParameter('argument', 'Spec', test.spec)
            }

            // add spec ids

            // these will be added on dashboard page
            currentTest.addParameter('environment-variable', 'BROWSER', test.runner[test.cid].browserName)
            currentTest.addParameter('environment-variable', 'BASE URL', this.config.baseUrl)
            currentTest.addParameter('environment-variable', 'WEBDRIVER HOST', this.config.host)
            currentTest.addParameter('environment-variable', 'WEBDRIVER PORT', this.config.port)
            currentTest.addParameter('environment-variable', 'SELENIUM CAPABILITIES', JSON.stringify(test.runner[test.cid]))
        })

        this.on('test:pass', (test) => {
            const allure = this.getAllure(test.cid)

            this.addArguments(test)
            allure.endCase('passed')
        })

        this.on('test:fail', (test) => {
            const allure = this.getAllure(test.cid)

            if (!allure.getCurrentTest()) {
                allure.startCase(test.title)
            } else {
                allure.getCurrentTest().name = test.title
            }

            while (allure.getCurrentSuite().currentStep instanceof Step) {
                allure.endStep('failed')
            }

            this.addArguments(test)
            allure.endCase('failed', {
                message: '\n' + test.err.message,
                stack: '\n' + test.err.stack
            })
        })

        this.on('test:broken', (test) => {
            const allure = this.getAllure(test.cid)

            if (!allure.getCurrentTest()) {
                allure.startCase(test.title)
            } else {
                allure.getCurrentTest().name = test.title
            }

            while (allure.getCurrentSuite().currentStep instanceof Step) {
                allure.endStep('broken')
            }

            this.addArguments(test)
            allure.endCase('broken', {
                message: '\n' + test.err.message,
                stack: '\n' + test.err.stack
            })
        })

        this.on('test:pending', (test) => {
            this.addArguments(test)
            this.getAllure(test.cid).pendingCase(test.title)
        })

        this.on('test:unverified', (test) => {
            const allure = this.getAllure(test.cid)

            if (!allure.getCurrentTest()) {
                allure.startCase(test.title)
            } else {
                allure.getCurrentTest().name = test.title
            }

            this.addArguments(test)
            allure.endCase('unknown', {
                message: '\n' + test.err.message,
                stack: ''
            })
        })

        this.on('runner:command', (command) => {
            const allure = this.getAllure(command.cid)

            if (!this.isAnyTestRunning(allure)) {
                return
            }

            if (debugSeleniumCommand) {
                allure.startStep(`${command.method} ${command.uri.path}`)

                if (!isEmpty(command.data)) {
                    this.dumpJSON(allure, 'Request', command.data)
                }
            }
        })

        this.on('runner:result', (command) => {
            const allure = this.getAllure(command.cid)
            let status = 'passed'

            if (!this.isAnyTestRunning(allure)) {
                return
            }

            if (debugSeleniumCommand) {
                if (command.requestOptions.uri.path.match(/\/wd\/hub\/session\/[^/]*\/screenshot/)) {
                    allure.addAttachment('Screenshot', new Buffer(command.body.value, 'base64'))
                } else {
                    if (command.body.screenshot) {
                        allure.addAttachment('Screenshot', new Buffer(command.body.screenshot, 'base64'))
                        delete command.body.screenshot
                    }
                    if (command.body.type && command.body.type === 'RuntimeError') {
                        status = 'broken'
                    }

                    this.dumpJSON(allure, 'Response', command.body)
                }
            }

            allure.endStep(status)
        })

        /*
           meta : {
            (mandatory) cid : ...,
            (mandatory) event : 'test:meta'
            (optional) description : string
            (optional) feature : string | array
            (optional) story : string | array
            (optional) issue : string | array
            (optional) severity : [ 'blocker','critical','normal','minor','trivial' ]
            (optional) argument : {name: value, name2: value }
            (optional) environment : {name: value, name2: value }
           }
        */
        this.on('test:meta', function (meta) {
            var allure = this.getAllure(meta.cid)
            logger('test:meta', meta)

            if (!this.isAnyTestRunning(allure)) {
                error('ERROR', 'test:meta : NO TEST RUNNING')
                return
            }
            const currentTest = allure.getCurrentTest()

            // manage description
            if (meta.description) {
                currentTest.setDescription(meta.description)
            }
            // manage labels ( feature, story, issue )
            if (meta.feature) {
                if (typeof (meta.feature) === 'string') {
                    currentTest.addLabel('feature', meta.feature)
                } else {
                    for (const i in meta.feature) {
                        currentTest.addLabel('feature', meta.feature[i])
                    }
                }
            }
            if (meta.story) {
                if (typeof (meta.story) === 'string') {
                    currentTest.addLabel('story', meta.story)
                } else {
                    for (const i in meta.story) {
                        currentTest.addLabel('story', meta.story[i])
                    }
                }
            }
            if (meta.issue) {
                if (typeof (meta.issue) === 'string') {
                    currentTest.addLabel('issue', meta.issue)
                } else {
                    for (const i in meta.issue) {
                        currentTest.addLabel('issue', meta.issue[i])
                    }
                }
            }
            if (meta.severity) {
                if (typeof (meta.severity) === 'string') {
                    currentTest.addLabel('severity', meta.severity)
                } else {
                    error('ERROR : meta.severity should be a string', meta)
                }
            }
            // manage parameters
            if (meta.argument) {
                if (typeof (meta.argument) === 'object') {
                    const keys = Object.keys(meta.argument)
                    for (const i in keys) {
                        const key = keys[i]
                        const val = meta.argument[key]
                        currentTest.addParameter('argument', key, val)
                    }
                } else {
                    error('ERROR : meta.argument should be an object { name2: val1, name2: val2.. }', meta)
                }
            }
            if (meta.environment) {
                if (typeof (meta.environment) === 'object') {
                    const keys = Object.keys(meta.environment)
                    for (const i in keys) {
                        const key = keys[i]
                        const val = meta.environment[key]
                        currentTest.addParameter('environment-variable', key, val)
                    }
                } else {
                    error('ERROR : meta.environment should be an object { name2: val1, name2: val2.. }', meta)
                }
            }
        })

        this.on('step:start', function (step) {
            const allure = this.getAllure(step.cid)
            logger('step:start', step)

            if (!this.isAnyTestRunning(allure)) {
                error('ERROR', 'cannot start step because no test is running', step)
                return
            }
            allure.startStep(step.title != null ? step.title : 'No name defined')

            if (step.arg) {
                this.dumpJSON(allure, 'Step Arg', step.arg)
            }
        })

        this.on('step:end', function (step) {
            const allure = this.getAllure(step.cid)
            logger('step:end', step)

            if (!this.isAnyTestRunning(allure)) {
                error('ERROR', 'cannot end step because no test is running', step)
                return
            }

            if (step.arg) {
                this.dumpJSON(allure, 'Step Result', step.arg)
            }

            if (step.assertionFailures) {
                this.dumpJSON(allure, 'Verification Failures', step.assertionFailures)
            }

            allure.endStep(step.status)
        })

        this.on('step:pass', function (step) {
            const allure = this.getAllure(step.cid)
            logger('step:pass', step)

            allure.endStep('passed')
        })

        this.on('step:fail', function (step) {
            const allure = this.getAllure(step.cid)
            logger('step:fail', step)

            this.dumpJSON(allure, 'Verification Failures', step.err)

            allure.endStep('failed')
        })

        this.on('step:unverified', function (step) {
            const allure = this.getAllure(step.cid)
            logger('step:unverified', step)

            this.dumpJSON(allure, 'Unverified Specifications', step.err)

            allure.endStep('unknown')
        })

        /*
          attachment : {
            cid: ...,
            event: 'test:attach',
            title: string,
            file: string,
            type: string
          }

        */
        this.on('test:attach', function (attachment) {
            const allure = this.getAllure(attachment.cid)
            logger('test:attach', attachment)

            if (this.isAnyTestRunning(allure)) {
                error('ERROR', 'cannot attach because no test is running', attachment)
                return
            }
            allure.addAttachment(
              attachment.title,
              fs.readFileSync(attachment.file),
              attachment.type
            )
        })

        /*
          log : {
            cid: ...,
            event: 'test:log',
            message: string,
            detail: object
          }

        */
        this.on('test:log', function (log) {
            const allure = this.getAllure(log.cid)
            logger('test:log', log)

            if (this.isAnyTestRunning(allure)) {
                error('ERROR', 'cannot log because no test is running', log)
                return
            }
            const content = log.detail != null ? JSON.stringify(log.detail, null, '    ') : ''
            allure.addAttachment(
              log.message, content, 'application/json'
            )
        })

        this.on('runner:screenshot', function (command) {
            const allure = this.getAllure(command.cid)
            allure.addAttachment('screenshot ' + command.filename, new Buffer(command.data, 'base64'))
        })

        this.on('hook:start', (hook) => {
            const allure = this.getAllure(hook.cid)

            if (!allure.getCurrentSuite() || LOGGING_HOOKS.indexOf(hook.title) === -1) {
                return
            }

            allure.startCase(hook.title)
        })

        this.on('hook:end', (hook) => {
            const allure = this.getAllure(hook.cid)

            if (!allure.getCurrentSuite() || LOGGING_HOOKS.indexOf(hook.title) === -1) {
                return
            }

            allure.endCase('passed')

            if (allure.getCurrentTest().steps.length === 0) {
                allure.getCurrentSuite().testcases.pop()
            }
        })
    }

    // add test.arguments to current test
    addArguments (test) {
        if (test.arguments) {
            for (const key in test.arguments) {
                if (test.arguments[key].value) {
                    this.getAllure(test.cid).getCurrentTest().addParameter('argument', test.arguments[key].caption, test.arguments[key].value)
                }
            }
        }
    }

    getAllure (cid) {
        if (typeof cid === 'undefined') {
            cid = process.workflo.cid
        } else {
            if (typeof process.workflo === 'undefined') {
                process.workflo = {
                }
            } else {
                process.workflo.currentCid = cid // REMOVE???
            }
        }

        if (this.allures[cid]) {
            return this.allures[cid]
        }

        const allure = new Allure()
        allure.setOptions({ targetDir: this.options.outputDir || 'allure-results' })
        this.allures[cid] = allure
        return this.allures[cid]
    }

    isAnyTestRunning (allure) {
        return allure.getCurrentSuite() && allure.getCurrentTest()
    }

    dumpJSON (allure, name, json) {
        const jsonStr = JSON.stringify(json, null, '    ').split(`\\\"`).join(`'`).replace(/(?:\\n)/g, '')
        allure.addAttachment(name, jsonStr, 'application/json')
    }
}

export default AllureReporter
