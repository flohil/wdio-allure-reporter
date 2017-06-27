import events from 'events'
import Allure from 'allure-js-commons'
import Step from 'allure-js-commons/beans/step'

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
        this.failedSpecs = {}

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
            currentTest.addParameter('environment-variable', 'capabilities', JSON.stringify(test.runner[test.cid]))
            currentTest.addParameter('environment-variable', 'spec files', JSON.stringify(test.specs))
            
            allure.workflo.failedSpecs = []
        })

        this.on('test:pass', (test) => {
            const allure = this.getAllure(test.cid)
            let status = 'passed'
            let err

            if (allure.workflo.specMode) {
                if (allure.workflo.failedSpecs.length > 0) {
                    status = 'failed'

                    const newErr = {
                        message: '',
                        stack: ''
                    }

                    newErr.message = allure.workflo.failedSpecs.map(function(err) { return err.message }).reduce(function(prev, cur) {
                        return prev + '\n' + cur
                    })

                    newErr.stack = allure.workflo.failedSpecs.map(function(err) { return err.stack }).reduce(function(prev, cur) {
                        return prev + '\n\n' + cur
                    })

                    newErr.message = '\n' + newErr.message + '\n'
                    newErr.stack = '\n' + newErr.stack

                    err = newErr
                }
            }

            allure.endCase(status, err)
        })

        this.on('test:fail', (test) => {
            const allure = this.getAllure(test.cid)
            const failedSpecs = this.getFailedSpecs()
            //const status = test.err.type === 'AssertionError' ? 'failed' : 'broken'
            let status = test.err.matcherName !== '' ? 'failed' : 'broken'

            if (!allure.getCurrentTest()) {
                allure.startCase(test.title)
            } else {
                allure.getCurrentTest().name = test.title
            }

            while (allure.getCurrentSuite().currentStep instanceof Step) {
                allure.endStep(status)
            }

            let newErr = {
                message: '',
                stack: ''
            }

            if (test.errs && test.errs.length > 0) {

                if (!allure.workflo.specMode) {
                    test.errs.forEach(function(err) {
                        //console.log("ERROR: ", err)

                        for(const key in err.specObj) {
                            if (!(key in failedSpecs)) {
                                failedSpecs[key] = {}
                            }

                            let criterias = err.specObj[key]

                            if (criterias.constructor !== Array) {
                                criterias = [criterias[key]]
                            }

                            console.log("CRITERIAS: ", test)

                            const splitIdx = test.parent.lastIndexOf("suite")
                            const suite = test.parent.substring(0, splitIdx)

                            for(const criteria of criterias) {
                                if(!(criteria in failedSpecs[key])) {
                                    failedSpecs[key][criteria] = []
                                }

                                failedSpecs[key][criteria].push({
                                    message: err.message,
                                    stack: err.stack,
                                    passed: err.passed,
                                    expected: err.expected,
                                    actual: err.actual,
                                    origin: `${suite}: ${test.title}`
                                })
                            }
                        }
                    })

                    newErr.message = test.errs.map(function(err) { return err.message }).reduce(function(prev, cur) {
                        return prev + '\n' + cur
                    })

                    newErr.stack = test.errs.map(function(err) { return err.stack }).reduce(function(prev, cur) {
                        return prev + '\n\n' + cur
                    })
                }
            } else {
                newErr.message = test.err.message
                newErr.stack = test.err.stack
            }

            newErr.message = '\n' + newErr.message + '\n'
            newErr.stack = '\n' + newErr.stack

            allure.endCase(status, newErr)
        })

        this.on('test:pending', (test) => {
            this.getAllure(test.cid).pendingCase(test.title)
        })

        this.on('runner:command', (command) => {
            const allure = this.getAllure(command.cid)

            if (!this.isAnyTestRunning(allure)) {
                return
            }

            if(debugSeleniumCommand) {
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

            if(debugSeleniumCommand) {
                if (command.requestOptions.uri.path.match(/\/wd\/hub\/session\/[^/]*\/screenshot/)) {
                    allure.addAttachment('Screenshot', new Buffer(command.body.value, 'base64'))
                } else {
                    if ( command.body.screenshot ) {
                        allure.addAttachment('Screenshot', new Buffer(command.body.screenshot, 'base64'))
                        delete command.body.screenshot
                    }
                    if ( command.body.type && command.body.type === 'RuntimeError' ) {
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
            (optional) strory : string | array
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
                error('ERROR','test:meta : NO TEST RUNNING')
                return
            }
            const currentTest = allure.getCurrentTest()
            
            // manage description
            if( meta.description ) {
                currentTest.setDescription(meta.description)          
            }
            // manage labels ( feature, story, issue )
            if( meta.feature ) {
                if( typeof(meta.feature)=='string' ) {
                    currentTest.addLabel( 'feature', meta.feature )
                } else {
                    for( const i in meta.feature ) {
                        currentTest.addLabel( 'feature', meta.feature[i] )
                    }
                }              
            }
            if( meta.story ) {
                if( typeof(meta.story)=='string' ) {
                    currentTest.addLabel( 'story', meta.story )
                } else {
                    for( const i in meta.story ) {
                        currentTest.addLabel( 'story', meta.story[i] )
                    }
                }              
            }
            if( meta.issue ) {
                if( typeof(meta.issue)=='string' ) {
                    currentTest.addLabel( 'issue', meta.issue )
                } else {
                    for( const i in meta.issue ) {
                        currentTest.addLabel( 'issue', meta.issue[i] )
                    }
                }              
            }
            if( meta.severity ) {
                if( typeof(meta.severity)=='string' ) {
                    currentTest.addLabel( 'severity', meta.severity )
                } else {
                    error('ERROR : meta.severity should be a string', meta)
                }              
            }
            // manage parameters
            if( meta.argument ) {
                if( typeof(meta.argument)=='object' ) {
                    const keys = Object.keys(meta.argument)
                    for( const i in keys ) {
                        const key = keys[i]
                        const val = meta.argument[key]
                        currentTest.addParameter( 'argument', key, val )
                    }
                } else {
                    error('ERROR : meta.argument should be an object { name2: val1, name2: val2.. }', meta)            
                }
            }
            if( meta.environment ) {
                if( typeof(meta.environment)=='object' ) {
                    const keys = Object.keys(meta.environment)
                    for( const i in keys ) {
                        const key = keys[i]
                        const val = meta.environment[key]
                        currentTest.addParameter( 'environment-variable', key, val )
                    }
                } else {
                    error('ERROR : meta.environment should be an object { name2: val1, name2: val2.. }', meta)               
                }
            }
        })

        this.on('step:failed', function(step) {
            const allure = this.getAllure(step.cid)
            allure.workflo.stepStatus = 'failed'

            const failedAssertion = {
                matcherName: step.assertion.matcherName,
                message: step.assertion.message
            }
           
            allure.workflo.failedAssertions.push(failedAssertion)
        });

        this.on('step:triggerSpecMode', function(step) {
            const allure = this.getAllure(step.cid)
            allure.workflo.specMode = true
        })

        this.on('step:verifyStart', function(step) {
            const allure = this.getAllure(step.cid);
            allure.workflo.verifyContainer = step.verifyContainer
        })

        this.on('step:verifyEnd', function(step) {
            const allure = this.getAllure(step.cid)
            allure.workflo.verifyContainer = undefined
        })

        this.on('step:start', function (step) {
            const allure = this.getAllure(step.cid)
            logger('step:start', step)

            if (!this.isAnyTestRunning(allure)) {
                error('ERROR','cannot start step because no test is running',step)
                return
            }
            allure.startStep(step.title!=null ? step.title : 'No name defined')

            if (step.arg) {
                this.dumpJSON(allure, 'Step Arg', step.arg)
            }
            
            allure.workflo.stepStatus = 'passed'
            allure.workflo.failedAssertions = []
        });   
        
        this.on('step:end', function (step) {
            const allure = this.getAllure(step.cid)
            const failedSpecs = this.getFailedSpecs()
            logger('step:end', step)

            if (!this.isAnyTestRunning(allure)) {
                error('ERROR','cannot end step because no test is running',step)
                return
            }

            let status = allure.workflo.stepStatus

            if(step.verify) {
                if(step.verify.storyId in failedSpecs && 
                    step.verify.criteriaId in failedSpecs[step.verify.storyId]) {
                    
                    status = 'failed'

                    allure.workflo.failedSpecs = allure.workflo.failedSpecs.concat(failedSpecs[step.verify.storyId][step.verify.criteriaId])

                    console.log("failed specs: ", failedSpecs[step.verify.storyId][step.verify.criteriaId])

                    this.dumpJSON(allure, 'Verification Failures', failedSpecs[step.verify.storyId][step.verify.criteriaId].map(failedAssertion => {
                        return {
                            origin: failedAssertion.origin,
                            message: failedAssertion.message,
                            stack: failedAssertion.stack
                        }
                    }))
                }
            }

            if (step.arg) {
                this.dumpJSON(allure, 'Step Result', step.arg)
            }

            if (step.type && step.type === 'verifyEnd' && allure.workflo.stepStatus === 'failed' && allure.workflo.failedAssertions.length > 0) {
                this.dumpJSON(allure, 'Verification Failures', allure.workflo.failedAssertions)
            }

            allure.endStep(step.status!=null ? step.status : status)
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
            const allure = _this.getAllure(attachment.cid)
            logger('test:attach', attachment)

            if (this.isAnyTestRunning(allure)) {
                error('ERROR','cannot attach because no test is running',attachment)
                return;
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
        });
        
        
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

    getAllure (cid) {
        if (typeof cid === 'undefined') {
            cid = process.workflo.cid
        } else {
            if (typeof process.workflo === 'undefined') {
                process.workflo = {
                }
            } else {
                process.workflo.currentCid = cid
            }
        }

        if (this.allures[cid]) {
            return this.allures[cid];
        }

        const allure = new Allure()
        allure.setOptions({ targetDir: this.options.outputDir || 'allure-results' })
        allure.workflo = {
            stepStatus: 'passed',
            verifyContainer: undefined,
            specMode: false, //first testcases are executed -> flase, then specs -> true
            failedSpecs: []
        }
        this.allures[cid] = allure
        return this.allures[cid]
    }

    getFailedSpecs() {
        return this.failedSpecs
    }

    isAnyTestRunning (allure) {
        return allure.getCurrentSuite() && allure.getCurrentTest()
    }

    dumpJSON (allure, name, json) {
        allure.addAttachment(name, JSON.stringify(json, null, '    ').split(`\\\"`).join(`'`), 'application/json')
    }
}

export default AllureReporter