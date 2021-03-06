
import angular from 'angular';
import moment from 'moment';

export default class ProgramStatusController {

    // TODO is "allWorkflows" correct?
    // TODO add support for special logic around "initial" and "terminal?"
    // TODO test with multiple workflows

    constructor($filter, $q, openmrsRest, openmrsTranslate) {
        'ngInject';

        Object.assign(this, {$filter, $q, openmrsRest, openmrsTranslate});
    }

    $onInit() {
        this.vPatientProgram = 'custom:uuid,program:(uuid),dateEnrolled,dateCompleted,outcome:(display),location:(display,uuid),dateCompleted,outcome,states:(uuid,startDate,endDate,voided,state:(uuid,concept:(display)))';

        this.dateFormat = (this.config.dateFormat == '' || angular.isUndefined(this.config.dateFormat))
            ? 'dd-MMM-yyyy' : this.config.dateFormat;
        this.today = new Date();

        this.program = null;
        this.patientProgram = null;
        this.programLocations = null;
        this.programOutcomes = null;

        this.canEnrollInProgram = false;
        this.canEditProgram = false;
        this.canDeleteProgram = false;

        this.statesByWorkflow = {};
        this.statesByUuid = {};
        this.patientStateHistory = [];
        this.mostRecentStateByWorkflow = {};

        // backs the various input fields
        this.input = {
            dateEnrolled: null,
            enrollmentLocation: null,
            dateCompleted: null,
            outcome: null,
            initialWorkflowStateByWorkflow: {},
            changeToStateByWorkflow: {}
        }

        // controls the state (open/closed) of the elements to edit enrollment & state information
        this.edit = {
            enrollment: false,
            workflow: {}
        }

        // controls whether the "confirm delete" message is displayed
        this.confirmDelete = false;

        this.activate();

        let ctrl = this;

    }

    activate() {
        this.openmrsRest.setBaseAppPath("/coreapps");

        this.fetchPrivileges();

        this.fetchLocations().then((response) => {
            this.fetchProgram().then((response) => {
                this.fetchOutcomes();
                this.fetchPatientProgram(this.config.patientProgram);
            });
        });
    }

    fetchPrivileges() {
        this.openmrsRest.get('session', {
            v: 'custom:(privileges)'
        }).then((response) => {
            if (response && response.user && angular.isArray(response.user.privileges)) {
                if (response.user.privileges.some( (p) => { return p.name === 'Task: coreapps.enrollInProgram'; })) {
                    this.canEnrollInProgram = true;
                };
                if (response.user.privileges.some( (p) => { return p.name === 'Task: coreapps.editPatientProgram'; })) {
                    this.canEditProgram = true;
                };
                if (response.user.privileges.some( (p) => { return p.name === 'Task: coreapps.deletePatientProgram'; })) {
                    this.canDeleteProgram = true;
                };
            }
        });
    }

    setInputsToStartingValues() {
        this.input.dateEnrolled = this.patientProgram ? new Date(this.patientProgram.dateEnrolled) : null;
        this.input.dateCompleted = this.patientProgram && this.patientProgram.dateCompleted ? new Date(this.patientProgram.dateCompleted) : null;
        this.input.outcome = this.patientProgram && this.patientProgram.outcome ? this.patientProgram.outcome.uuid : null;

        if (this.patientProgram && this.patientProgram.location) {
            this.input.enrollmentLocation = this.patientProgram.location.uuid;
        }
        // if there is only possible location, set it as the default (this is why loading locations (in activate) needs to happen before patient programs)
        else if (this.programLocations && this.programLocations.length == 1) {
            this.input.enrollmentLocation = this.programLocations[0].uuid;
        }
    }

    convertDateEnrolledAndDateCompletedStringsToDates() {
        if (this.patientProgram) {
            this.patientProgram.dateEnrolled = this.patientProgram ? new Date(this.patientProgram.dateEnrolled) : null;
            this.patientProgram.dateCompleted = this.patientProgram && this.patientProgram.dateCompleted ? new Date(this.patientProgram.dateCompleted) : null;
        }
    }

    toggleEditEnrollment() {
        let currentStatus = this.edit.enrollment;
        this.cancelAllEditModes()
        this.edit.enrollment = !currentStatus;
    }

    toggleEditWorkflow(workflowUuid) {
        let currentStatus = this.edit.workflow[workflowUuid];
        this.cancelAllEditModes();

        // the first time we hit this, we need to initialize the workflow
        if (!workflowUuid in this.edit.workflow) {
            this.edit.workflow[workflowUuid] = true
        }
        else {
            this.edit.workflow[workflowUuid] = !currentStatus;
        }
    }

    fetchProgram() {
        return this.openmrsRest.get('program', {
            uuid: this.config.program,
            v: 'custom:display,uuid,outcomesConcept:(uuid),allWorkflows:(uuid,concept:(display),states:(uuid,concept:(display))'
        }).then((response) => {
            // TODO handle error cases, program doesn't exist
            this.program = response;

            angular.forEach(this.program.allWorkflows, (workflow) => {
                this.statesByWorkflow[workflow.uuid] = workflow.states;
                angular.forEach(workflow.states, (state) => {
                    this.statesByUuid[state.uuid] = state;
                });
            });
        });
    }

    fetchPatientProgram(patientProgramUuid) {
        if (!patientProgramUuid) {
            // we haven't been been given a patient program uuid, so load the programs and pick the active program (if it exists)
            return this.openmrsRest.get('programenrollment', {
                patient: this.config.patientUuid,
                v: this.vPatientProgram
            }).then((response) => {
                this.getActiveProgram(response.results);
                this.groupAndSortPatientStates();
                this.setInputsToStartingValues();
                this.convertDateEnrolledAndDateCompletedStringsToDates();
            });
        }
        else {
            // we've been given a specific patient program uuid, load that one
            return this.openmrsRest.get('programenrollment', {
                uuid: patientProgramUuid,
                v: this.vPatientProgram
            }).then((response) => {
                this.patientProgram = response;
                this.groupAndSortPatientStates();
                this.setInputsToStartingValues();
                this.convertDateEnrolledAndDateCompletedStringsToDates();;
            })
        }
    }

    fetchLocations() {
        return this.openmrsRest.get('location', {
            v: 'custom:display,uuid',
            tag: this.config.locationTag,
        }).then((response) => {
            this.programLocations = response.results;
        })
    }


    fetchOutcomes() {
        if (this.program.outcomesConcept) {
            return this.openmrsRest.get('concept', {
                v: 'custom:answers:(display,uuid)',
                uuid: this.program.outcomesConcept.uuid,
            }).then((response) => {
                this.programOutcomes = response.answers;
            })
        }
    }

    getActiveProgram(patientPrograms) {

        // only patient programs of the specified type
        patientPrograms = this.$filter('filter') (patientPrograms, (patientProgram) => {
            return (patientProgram.program.uuid == this.config.program
                && patientProgram.dateCompleted == null);
        });

        if (patientPrograms.length > 0) {
            patientPrograms = this.$filter('orderBy')(patientPrograms, (patientProgram) => {
                return -patientPrograms.startDate;
            });

            this.patientProgram = patientPrograms[0];
        }
    }

    enrollInProgram() {
        if (this.input.dateEnrolled && this.input.enrollmentLocation) {

            var states = [];
            angular.forEach(this.input.initialWorkflowStateByWorkflow, (state) => {
                state.startDate = this.input.dateEnrolled;
                states.push(state);
            });

            this.openmrsRest.create('programenrollment', {
                patient: this.config.patientUuid,
                program: this.config.program,
                dateEnrolled: this.input.dateEnrolled,
                location: this.input.enrollmentLocation,
                states: states
            }).then((response) => {
                this.fetchPatientProgram(); // refresh display

            });

        }
    }

    updatePatientProgram() {
        this.openmrsRest.update('programenrollment/' + this.patientProgram.uuid, {
            dateEnrolled: this.input.dateEnrolled,
            dateCompleted: this.input.dateCompleted,
            location: this.input.enrollmentLocation,
            outcome: this.input.outcome
        }).then((response) => {
            this.fetchPatientProgram(this.patientProgram.uuid); // refresh display
        })
    }

    deletePatientProgram() {

        if (!this.confirmDelete) {
            this.confirmDelete = true;
        }
        else {
            this.confirmDelete = false;
            this.openmrsRest.remove('programenrollment/', {
                uuid: this.patientProgram.uuid
            }).then((response) => {
                this.patientProgram = null;
                this.fetchPatientProgram(); // refresh display
            })
        }
    }

    createPatientState(state) {
        this.openmrsRest.update('programenrollment/' + this.patientProgram.uuid, {
            states: [
                {
                    state: state.state,
                    startDate: state.date    // TODO is it okay that we set this date on the client-side? need to sync with
                }
            ]
        }).then((response) => {
            // TODO: handle error cases
            this.fetchPatientProgram(this.patientProgram.uuid); // refresh display
        })
    }

    getWorkflowForState(state) {
        let result;
        angular.forEach(this.program.allWorkflows, (workflow) => {
            angular.forEach(workflow.states, (workflowState) => {
                if (state.uuid == workflowState.uuid) {
                    result = workflow;
                }
            })
        })
        return result;
    }

    voidPatientStates(patientStateUuids) {

        let voidCalls = [];

        angular.forEach(patientStateUuids, (patientStateUuid) => {
            voidCalls.push(this.openmrsRest.remove('programenrollment/' + this.patientProgram.uuid + "/state/" + patientStateUuid, {
                voided: "true",
                voidReason: "voided via UI"
            }));
        });

        this.$q.all(voidCalls).then((response) => {
            // TODO: handle error cases
            this.fetchPatientProgram(this.patientProgram.uuid); // refresh display
        });

    }

    updatePatientState(workflowUuid, stateUuid) {
        this.edit.workflow[workflowUuid] = false;
        this.createPatientState(this.input.changeToStateByWorkflow[workflowUuid])
    }

    deleteMostRecentPatientStates() {
        if (this.patientStateHistory.length > 0) {
            var stateUuids = [];
            for (var workflow in this.patientStateHistory[0].patientStatesByWorkflow) {
                stateUuids.push(this.patientStateHistory[0].patientStatesByWorkflow[workflow].uuid)
            }
            this.voidPatientStates(stateUuids);
        }
    }

    isNotCurrentState(workflow) {
        return (state) => {
            var currentState = this.mostRecentStateByWorkflow[workflow.uuid];
            return !currentState || currentState.state.uuid != state.uuid;
        }

    }

    // this creates the data to back the program history table and the control the start date values of some of the state transition widgets
    // "patientStateHistory" is an array, with an entry for each row in the table
    // each element in the array an object with two properties:
    //      * startDate
    //      * patientStatesByWorkflow: a map where the keys are the workflow uuids, and the value is the state for that workflow on the given state
    // "lastStateChangeDateByWorkflow": a map from workflowUuid to the last time the state in that workflow changed
    groupAndSortPatientStates() {
        this.patientStateHistory = [];
        this.mostRecentStateByWorkflow = {};

        if (this.patientProgram && this.patientProgram.states) {
            // TODO remove this first filter once the bug with the REST request returning voided elements is fixed
            this.patientProgram.states = this.$filter('filter')(this.patientProgram.states, (state) => {
                return !state.voided
            }, true);
            this.patientProgram.states = this.$filter('orderBy')(this.patientProgram.states, (state) => {
                return state.startDate
            });

            angular.forEach(this.patientProgram.states, (patientState) => {
                let workflow = this.getWorkflowForState(patientState.state);
                // first update the lastStateChangeDateByWorkflow--since we sorting from earliest to latest, we can just overwrite and assume the last value set is the latest
                this.mostRecentStateByWorkflow[workflow.uuid] = patientState;
                // hack to change startDate from a UTC string to Date
                this.mostRecentStateByWorkflow[workflow.uuid].startDate = new Date(this.mostRecentStateByWorkflow[workflow.uuid].startDate);
                this.mostRecentStateByWorkflow[workflow.uuid].dayAfterStartDate = this.getNextDay(this.mostRecentStateByWorkflow[workflow.uuid].startDate);

                patientState['workflow'] = workflow;

                if (this.patientStateHistory.length > 0 &&
                    this.patientStateHistory[0].startDate == patientState.startDate) {
                    // assumption: only one state per workflow per day
                    this.patientStateHistory[0]['patientStatesByWorkflow'][workflow.uuid] = patientState;
                }
                else {
                    var newEntry = {};
                    newEntry['startDate'] = new Date(patientState.startDate);
                    newEntry['patientStatesByWorkflow'] = {};
                    newEntry['patientStatesByWorkflow'][workflow.uuid] = patientState;
                    this.patientStateHistory.unshift(newEntry);  // add to front
                }
            })
        }
    }

    update() {
        this.cancelAllEditModes();
        this.updatePatientProgram();
    }

    cancelAllEditModes() {
        this.edit.enrollment = false;
        for (let uuid in this.edit.workflow) {
            this.edit.workflow[uuid] = false
        }
    }

    cancelEdit() {
        this.cancelAllEditModes();
        this.setInputsToStartingValues();
    }

    cancelDelete() {
        this.confirmDelete = false;
    }


    hasHistory() {
        return this.patientStateHistory.length > 0;
    }

    editingAnyWorkflow() {
        var result = false;
        angular.forEach(this.edit.workflow, function (value, key) {
            if (value === true) {
                result = true;
            }
        })
        return result;
    }

    getNextDay(date) {
        return moment(date).add(1, 'days').toDate();
    }

    isToday(date) {
        if (!date) {
            return false;
        }
        else {
           return moment(date).isSame(moment(), 'day');
        }
    }

    enrollmentValid() {
        return this.input.enrollmentLocation && this.input.dateEnrolled &&  // must have enrollmentLocation and date enrolled
            (!this.input.dateCompleted || this.input.dateCompleted >= this.input.dateEnrolled) &&  // date completed must be after date enrolled
            ((!this.input.dateCompleted && !this.input.outcome) || (this.input.dateCompleted && this.input.outcome));  // if there's a completion date, must specific an outcome (and vice versa)
    }

    workflowTransitionValid(workflowUuid) {
        return this.input.changeToStateByWorkflow[workflowUuid] && this.input.changeToStateByWorkflow[workflowUuid].date && this.input.changeToStateByWorkflow[workflowUuid].state;
    }

}