Ext.define('CustomApp', {
    extend: 'Rally.app.App',
    componentCls: 'app',
    items: [
        {
            xtype: 'container',
            itemId: 'iterationDropDown',
            columnWidth: 1
        },
        {
            xtype: 'container',
            itemId: 'mychart',
            columnWidth: 1
        }
    ],

    _startingScheduleState: 'In-Progress',
    _endingScheduleState: 'Accepted',

    planEstimateHash: null,
    myChart: null,
    myChartText: null,
    iterationStore: null,
    snapshotStore: null,
    selectedIterationOIDs: [],

    launch: function() {

        // console.log('launch');

        // Grab and use the timebox scope if we have it
        var timeboxScope = this.getContext().getTimeboxScope();
        if(timeboxScope) {
            var record = timeboxScope.getRecord();
            var name = record.get('Name');

            this.myIteration = record.data;
            this._onIterationSelect();

        // Otherwise add an iteration combo box to the page
        } else {
            // add the iteration dropdown selector
            this.down("#iterationDropDown").add( {
                xtype: 'rallyiterationcombobox',
                itemId : 'iterationSelector',
                listeners: {
                    select: this._onIterationSelect,
                    ready:  this._onIterationSelect,
                    scope:  this
                }
            });
        }

    },

    onTimeboxScopeChange: function(newTimeboxScope) {

        // console.log('onTimeboxScopeChange');

        this.callParent(arguments);

        if(newTimeboxScope) {
            var record = newTimeboxScope.getRecord();

            this.myIteration = record.data;
            this._onIterationSelect();
        }
    },

    _onIterationSelect : function() {

        // console.log('_onIterationSelect');

        var me = this;
        var value;

        if (_.isUndefined( this.getContext().getTimeboxScope())) {
            value =  this.down('#iterationSelector').getRecord();
            this.myIteration = value.data;
        }

        var iterationName = value.get('Name');

        this.iterationStore = Ext.create('Rally.data.wsapi.Store', {
            model: 'Iteration',
            autoLoad: true,
            filters: [
                {
                    property: 'Name',
                    operator: '=',
                    value: iterationName
                }
            ],
            context: {
                project: me.getContext().getProjectRef(),
                projectScopeUp: me.getContext().getProjectScopeUp(),
                projectScopeDown: me.getContext().getProjectScopeDown()
            },
            listeners: {
                load: function(store, data, success) {
                    me._iterationStoreLoaded(store, data, success, me);
                }
            },
            fetch: ['Name', 'ObjectID']
        });

        // console.log(value.get('Name'));

    },

    _iterationStoreLoaded: function(store, data, success, scope) {

        // console.log('_iterationStoreLoaded');
        var me = scope;

        me.selectedIterationOIDs = [];

        Ext.Array.each(data, function(record){
            me.selectedIterationOIDs.push(record.get('ObjectID'));
        });

        // console.log("ObjectID's of selected Iterations:");
        // console.log(me.selectedIterationOIDs);

        me._getSnapshotData(me);
    },

    _getSnapshotData: function(scope) {

        // console.log('_getSnapshotData');
        var me = scope;

        me.setLoading('Querying snapshot data');

        Ext.create('Rally.data.lookback.SnapshotStore', {
            limit: Infinity,
            autoLoad: true,
            listeners: {
                load: me._processSnapshotData,
                scope : me
            },
            fetch: ['ObjectID','Name', 'Priority','ScheduleState', 'PlanEstimate','TaskEstimateTotal','TaskRemainingTotal'],
            hydrate: ['ScheduleState'],
            compress: true,
            removeUnauthorizedSnapshots: true,
            filters: [
                {
                    property: '_TypeHierarchy',
                    operator: 'in',
                    value: ['HierarchicalRequirement','Defect']
                },
                {
                    property: 'Iteration',
                    operator: 'in',
                    value: me.selectedIterationOIDs
                }
            ]
        });
    },

    _processSnapshotData : function(store, data, success) {

        // console.log('_processSnapshotData');

        var me = this;

        me.setLoading('Calculating Cycle Time');

        var workProductOIDs = [];
        var snapshotsByWorkProductOID = {};
        var cycleTimeVsPlanEstimate = [];

        if (data.length === 0) {
            me.setLoading(false);
            me._showChart(cycleTimeVsPlanEstimate);
        }

        // Extract ObjectID's - store an array of Snapshots per ObjectID in a Hash
        Ext.Array.each(data, function(record) {
            var thisObjectID = record.get('ObjectID');
            if (workProductOIDs.indexOf(thisObjectID) === -1) {
                workProductOIDs.push(thisObjectID);

                // Get Snapshots for this OID
                var theseSnapshots = _.filter(data, function(thisRecord) {
                    return thisRecord.get('ObjectID') === thisObjectID;
                });

                snapshotsByWorkProductOID[thisObjectID.toString()] = theseSnapshots;
            }
        });

        // console.log("ObjectID's of Work Products in Selected Iteration:");
        // console.log(workProductOIDs);

        // console.log("Hash of Snapshots by ObjectID:");
        // console.log(snapshotsByWorkProductOID);

        // Calculate Cycle time for Accepted work products
        Ext.iterate(snapshotsByWorkProductOID, function(objectID, snapshots) {

            var lastSnapshotStartState = _.last(Ext.Array.filter(snapshots, function(record){
                return record.get('ScheduleState') === me._startingScheduleState;
            }));

            var lastSnapshotEndState = _.last(Ext.Array.filter(snapshots, function(record){
                return record.get('ScheduleState') === me._endingScheduleState;
            }));

            if ((typeof lastSnapshotStartState !== 'undefined') && (typeof lastSnapshotEndState !== 'undefined')) {
                var endStatePlanEstimate = lastSnapshotEndState.get('PlanEstimate');
                var startStateDateString = lastSnapshotStartState.get('_ValidFrom');
                var endStateDateString = lastSnapshotEndState.get('_ValidFrom');

                var cycleTime = Rally.util.DateTime.getDifference(new Date(endStateDateString), new Date(startStateDateString), 'day');

                cycleTimeVsPlanEstimate.push([endStatePlanEstimate, cycleTime]);
            }
        });

        me._showChart(cycleTimeVsPlanEstimate);
    },

    _sortArrays: function(arr, sortArr) {
        var result = [];
        for(var i=0; i < arr.length; i++) {
            result[i] = arr[sortArr[i]];
        }
        return result;
    },

    _stringArrayToIntArray: function(stringArray) {
        var result = [];
        Ext.Array.each(stringArray, function(thisString) {
            result.push(parseInt(thisString, 10));
        });
        return result;
    },

    _showChart : function(data) {

        // console.log('_showChart');

        var me = this;
        me.setLoading(false);

        var chartDiv = this.down("#mychart");
        chartDiv.removeAll();
        if (me.myChart) {
            me.myChart.destroy();
        }

        if (data.length > 0) {
            me.myChart = Ext.create('Rally.ui.chart.Chart', {
                chartData: {
                    series: [
                        {
                            type: 'scatter',
                            data: data,
                            name: 'CycleTime',
                            color: "##00FF00"
                        }
                    ]
                },

                chartConfig: {
                    chart: {
                        type: 'scatter',
                        zoomType: 'xy'
                    },
                    title: {
                        text: 'Cycle Time Vs. Plan Estimate',
                        align: 'center'
                    },
                    xAxis: [
                        {
                            title: {
                                enabled: true,
                                text: 'Plan Estimate (Points)'
                            },
                            startOnTick: true,
                            endOnTick: true,
                            showLastLabel: true
                        }
                    ],
                    yAxis: [
                        {
                            title: {
                                enabled: true,
                                text: 'Cycle Time (Days)',
                                style: {
                                    fontWeight: 'normal'
                                }
                            },
                            min: 0
                        }
                    ]
                }
            });

            me.myChart.setChartColors(['#00FF00']);

            chartDiv.add(me.myChart);
            me.myChart._unmask();
        } else {
            chartDiv.add({
                xtype: 'container',
                html: 'Insufficient data for this iteration.'
            });
        }
    }
});