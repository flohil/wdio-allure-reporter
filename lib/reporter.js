import events from 'events'
import Allure from 'allure-js-commons-workflo'
import Step from 'allure-js-commons-workflo/beans/step'
import * as fs from 'fs'
import * as path from 'path'

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
        this.currentTestId = ''
        this.startedSpecs = false
        this.testIds = {}
        this.errorCtr = 0

        // const { epilogue } = this.baseReporter

        this.dumpFailuresAndErrors = function (allure, assertions) {
            var failures = assertions.filter(function (assertion) { return typeof assertion.matcherName !== 'undefined' })
            var errors = assertions.filter(function (assertion) { return typeof assertion.matcherName === 'undefined' })

            if (failures.length > 0) {
                this.dumpJSON(allure, 'Validation Failures', failures)
            }

            if (errors.length > 0) {
                this.dumpJSON(allure, 'Errors', errors)
            }
        }

        this.on('end', () => {
            // epilogue.call(baseReporter)
            if (this.startedSpecs) {
                this.addResults()
            }
        })

        this.on('startSpecs', (runner) => {
            if (!this.startedSpecs) {
                this.startedSpecs = true
            }
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

        this.on('test:setCurrentId', (test) => {
            const allure = this.getAllure(test.cid)
            this.currentTestId = test.id

            const currentTest = allure.getCurrentTest()

            if (this.currentTestId) {
                if (test.testcase) {
                    const traceInfo = this.config.traceInfo.testcases[this.currentTestId]

                    currentTest.addParameter('argument', 'Testcase File', traceInfo.testcaseFile)
                    currentTest.addParameter('argument', 'Validates Specs', traceInfo.specs.join(', '))
                } else if (test.spec) {
                    const parts = this.currentTestId.split('|')
                    const spec = parts[0]
                    const criteria = parts[1]

                    const traceInfo = this.config.traceInfo.specs[spec]

                    currentTest.addParameter('argument', 'Spec File', traceInfo.specFile)

                    const manualFile = traceInfo.criteriaValidationFiles[criteria].manualFile
                    const testcases = traceInfo.criteriaValidationFiles[criteria].testcases

                    if (manualFile) {
                        currentTest.addParameter('argument', 'Validated by Manual Results', manualFile)
                    } else if (testcases.length > 0) {
                        currentTest.addParameter('argument', 'Validated in Testcases', testcases.join(', '))
                    }
                }
            }
        })

        this.on('test:start', (test) => {
            const allure = this.getAllure(test.cid)
            allure.startCase(test.title)

            this.lastCid = test.cid

            const currentTest = allure.getCurrentTest()

            if (test.metadata) {
                for (const key in test.metadata) {
                    const meta = {
                        event: 'test:meta',
                        cid: test.cid
                    }
                    meta[key] = test.metadata[key]

                    this.handleMetadata(meta)
                }
            }

            // add spec ids
            let printObject = this.config.printObject

            const filterFilesStr = `${printObject['Spec Files']} specFiles, ${printObject['Testcase Files']} testcaseFiles, ${printObject['Manual Result Files']} manualResultFiles`
            const filtersStr = `${printObject['Features']} features, ${printObject['Specs']} specs, ${printObject['Suites']} suites, ${printObject['Testcases']} testcases`
            const coverageStr = `${printObject['Automated Criteria'].count} automated ${printObject['Automated Criteria'].percentage}, ${printObject['Manual Criteria'].count} manual ${printObject['Manual Criteria'].percentage}, ${printObject['Uncovered Criteria'].count} uncovered ${printObject['Uncovered Criteria'].percentage}`
            let uncoveredCriteriaStr = ''

            for (const spec in printObject['Uncovered Criteria Object']) {
                uncoveredCriteriaStr += `${spec}: [${printObject['Uncovered Criteria Object'][spec].join(', ')}], `
            }

            uncoveredCriteriaStr = uncoveredCriteriaStr.substring(0, uncoveredCriteriaStr.length - 2)

            // these will be added on dashboard page
            currentTest.addParameter('environment-variable', 'BROWSER', test.runner[test.cid].browserName)
            currentTest.addParameter('environment-variable', 'BASE URL', this.config.baseUrl)

            if (this.config.manualOnly) {
                currentTest.addParameter('environment-variable', 'EXECUTION MODE: ', 'Manual Only')
            } else if (this.config.automaticOnly) {
                currentTest.addParameter('environment-variable', 'EXECUTION MODE: ', 'Automatic Only')
            } else {
                currentTest.addParameter('environment-variable', 'EXECUTION MODE: ', 'Automatic and Manual')
            }

            // currentTest.addParameter('environment-variable', 'SELENIUM CAPABILITIES', JSON.stringify(test.runner[test.cid]))
            // currentTest.addParameter('environment-variable', 'WEBDRIVER HOST', this.config.host)
            // currentTest.addParameter('environment-variable', 'WEBDRIVER PORT', this.config.port)
            currentTest.addParameter('environment-variable', 'CRITERIA COVERAGE: ', coverageStr)
            currentTest.addParameter('environment-variable', 'FILTER FILES: ', filterFilesStr)
            currentTest.addParameter('environment-variable', 'FILTERS: ', filtersStr)

            if (uncoveredCriteriaStr) {
                currentTest.addParameter('environment-variable', 'UNCOVERED CRITERIA: ', uncoveredCriteriaStr)
            }
        })

        this.on('test:pass', (test) => {
            const allure = this.getAllure(test.cid)

            this.addArguments(test)
            this.addResultsDummy(test)
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
            this.addResultsDummy(test)
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
            this.addResultsDummy(test)

            allure.endCase('broken', {
                message: '\n' + test.err.message,
                stack: '\n' + test.err.stack
            })
        })

        this.on('test:pending', (test) => {
            const allure = this.getAllure(test.cid)

            this.addArguments(test)
            this.addResultsDummy(test)
            allure.endCase('pending', {message: 'Test ignored', stack: ''})
        })

        this.on('test:unvalidated', (test) => {
            const allure = this.getAllure(test.cid)

            if (!allure.getCurrentTest()) {
                allure.startCase(test.title)
            } else {
                allure.getCurrentTest().name = test.title
            }

            this.addArguments(test)
            this.addResultsDummy(test)
            allure.endCase('unknown', {
                message: '\n' + test.err.message
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
                if (command.body.screenshot) {
                    allure.addAttachment('Screenshot', new Buffer(command.body.screenshot, 'base64'))
                    delete command.body.screenshot
                }
                if (command.body.type && command.body.type === 'RuntimeError') {
                    status = 'broken'
                }

                this.dumpJSON(allure, 'Response', command.body)

                allure.endStep(status)
            }
        })

        /*
           meta : {
            (mandatory) cid : ...,
            (mandatory) event : 'test:meta'
            (optional) description : string
            (optional) feature : string | array
            (optional) story : string | array
            (optional) issue : string | array // bugs???
            (optional) severity : [ 'blocker','critical','normal','minor','trivial' ]
            (optional) argument : {name: value, name2: value }
            (optional) environment : {name: value, name2: value }
           }
        */
        this.on('test:meta', function (meta) {
            this.handleMetadata(meta)
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
                this.dumpFailuresAndErrors(allure, step.assertionFailures)
            }

            if (step.screenshots) {
                for (var screenshotMessage in step.screenshots) {
                    for (var i = 0; i < step.screenshots[screenshotMessage].length; ++i) {
                        var screenshots = step.screenshots[screenshotMessage]
                        if (screenshots && screenshots[i]) {
                            allure.addAttachment('Screenshot_' + screenshots[i].id + ': \'' + screenshotMessage + '\'', new Buffer(fs.readFileSync(screenshots[i].filename, { encoding: 'base64' }), 'base64'))
                        }
                    }
                }
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

            this.dumpFailuresAndErrors(allure, step.errs)

            if (step.screenshots) {
                for (var screenshotMessage in step.screenshots) {
                    for (var i = 0; i < step.screenshots[screenshotMessage].length; ++i) {
                        var screenshots = step.screenshots[screenshotMessage]
                        if (screenshots && screenshots[i]) {
                            allure.addAttachment('Screenshot_' + screenshots[i].id + ': \'' + screenshotMessage + '\'', new Buffer(fs.readFileSync(screenshots[i].filename, { encoding: 'base64' }), 'base64'))
                        }
                    }
                }
            }

            allure.endStep('failed')
        })

        this.on('step:broken', function (step) {
            const allure = this.getAllure(step.cid)
            logger('step:broken', step)

            this.dumpFailuresAndErrors(allure, [step.assertion])

            if (step.assertion.screenshotFilename) {
                allure.addAttachment('Screenshot_' + step.assertion.screenshotId + ': \'' + step.assertion.message + '\'', new Buffer(fs.readFileSync(step.assertion.screenshotFilename, { encoding: 'base64' }), 'base64'))
            }

            allure.endStep('broken')
        })

        this.on('step:unvalidated', function (step) {
            const allure = this.getAllure(step.cid)
            logger('step:unvalidated', step)

            this.dumpJSON(allure, 'unvalidated Specifications', step.err)

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
            // const allure = this.getAllure(command.cid)
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

    handleMetadata (meta) {
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
                for (const issue of meta.issue) { // string array, previously "in"
                    currentTest.addLabel('issue', issue)
                }
            }
        }
        if (meta.bug) {
            if (typeof (meta.bug) === 'string') {
                currentTest.addLabel('issue', this.getBug(meta.bug)) // check if 'bug' can be used instead!
                currentTest.addLabel('bug', this.getBug(meta.bug))
            } else {
                for (const bug of meta.bug) {
                    currentTest.addLabel('issue', this.getBug(bug))
                    currentTest.addLabel('bug', this.getBug(bug))
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
    }

    getBug (bug) {
        if (this.config.allure && this.config.allure.bugAppendix) {
            bug = `${bug}${this.config.allure.bugAppendix}`
        }
        if (this.config.allure && this.config.allure.bugPrefix) {
            bug = `${this.config.allure.bugPrefix}${bug}`
        }
        return bug
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

    buildResultStr (results) {
        let str = ''

        str += `${results.passing.count} passing (~${Math.round(results.passing.percentage)}%)`

        if (results.skipped.count > 0) {
            str += `, ${results.skipped.count} skipped (~${Math.round(results.skipped.percentage)}%)`
        }

        if (results.unvalidated.count > 0) {
            str += `, ${results.unvalidated.count} unvalidated (~${Math.round(results.unvalidated.percentage)}%)`
        }

        if (results.failing.count > 0) {
            str += `, ${results.failing.count} failing (~${Math.round(results.failing.percentage)}%)`
        }

        if (results.broken.count > 0) {
            str += `, ${results.broken.count} broken (~${Math.round(results.broken.percentage)}%)`
        }

        return str
    }

    addResultsDummy (test) {
        if (test.cid) {
            const allure = this.getAllure(test.cid)
            const currentTest = allure.getCurrentTest()

            this.testIds[currentTest] = true

            currentTest.addParameter('environment-variable', 'TESTCASE RESULTS: ', 'TESTCASE_RESULTS_STR')
            currentTest.addParameter('environment-variable', 'SPEC RESULTS: ', 'SPEC_RESULTS_STR')
        }
    }

    addResults () {
        const tcResults = this.baseReporter.getTestcaseResults()
        const specResults = this.baseReporter.getSpecResults()

        let tcResultsStr = this.buildResultStr(tcResults)
        let specResultsStr = this.buildResultStr(specResults)

        const latestRun = fs.readFileSync(this.config.latestRunPath, 'utf8')

        // replace TESTCASE_RESULTS_STR and SPEC_RESULTS_STR in all xml and json files in results folder
        // unfortunately there is not better way to do this at the moment
        getAllFiles(path.join(this.config.resultsPath, latestRun), '.xml').forEach(
            file => {
                let content = fs.readFileSync(file, 'utf8')

                content = content.replace(/TESTCASE_RESULTS_STR/g, tcResultsStr)
                content = content.replace(/SPEC_RESULTS_STR/g, specResultsStr)

                fs.unlinkSync(file)

                fs.writeFileSync(file, content, 'utf8')
            }
        )
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

const read = (dir) =>
fs.readdirSync(dir)
.reduce(
  (files, file) =>
  fs.statSync(path.join(dir, file)).isDirectory()
    ? files.concat(read(path.join(dir, file)))
    : files.concat(path.join(dir, file)),
  []
)

function getAllFiles (dirPath, extension) {
    return read(dirPath).filter(
    (fileName) => fileName.endsWith(extension)
    )
}

export default AllureReporter
