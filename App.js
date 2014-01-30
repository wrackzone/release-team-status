var app = null;

Ext.define('CustomApp', {
    extend: 'Rally.app.App',
    componentCls: 'app',
    // items:{ html:'<a href="https://help.rallydev.com/apps/2.0rc2/doc/">App SDK 2.0rc2 Docs</a>'},
    launch: function() {
        //Write app code here
        app = this;
        app.addReleaseDropDown();
    },

    addReleaseDropDown : function() {

        app.dropDown = Ext.create('Rally.ui.combobox.ReleaseComboBox', {
            listeners : {
                scope : this,
                select : function() {
                    app.reload();
                }
            }
        });

        app.add(app.dropDown);
    },

    reload : function() {

        console.log("release",app.dropDown.getRecord());

        var releaseName = app.dropDown.getRecord().get("Name");
        // ["Name","Owner","Iteration","Release","Project","Estimate","ToDo"]
        var configs = [{model:"Task",fetch:true,filters:[{property:"Release.Name",operator:"=",value:releaseName}]}];
        async.map( configs,app.wsapiQuery,function(err,results){

            var tasks = results[0];
            console.log("tasks",tasks);

            // construct query for user iteration capacity
            var userIterations = _.map(tasks,function(t) {
                return { user : t.get("Owner"), iteration : t.get("Iteration")};
            });
            userIterations = _.uniq(userIterations);
            userIterations = _.filter(userIterations,function(ui) { 
                return (!_.isUndefined(ui.user) && !_.isUndefined(ui.iteration) &&
                    (!_.isNull(ui.user) && !_.isNull(ui.iteration))
                    );
            })
            console.log("userIterations",userIterations);

            var configs = _.map(userIterations,function(ui) {
                return {
                    model:"UserIterationCapacity",
                    fetch:true,
                    filters:[
                        { property : "Iteration", operator : "=", value : ui.iteration._ref },
                        { property : "User", operator : "=", value : ui.user._ref}
                    ]
                }
            });

            async.map( configs, app.wsapiQuery,function(err,results) {
                app.tasks = tasks;
                app.capacities = _.map(results,function(r) { return r[0];});
                console.log("app.capacities",app.capacities);
                app.addTreeGrid();
            });

            

        });      

    },

    // generic function to perform a web services query    
    wsapiQuery : function( config , callback ) {
        Ext.create('Rally.data.WsapiDataStore', {
            autoLoad : true,
            limit : "Infinity",
            model : config.model,
            fetch : config.fetch,
            filters : config.filters,
            listeners : {
                scope : this,
                load : function(store, data) {
                    callback(null,data);
                }
            }
        });
    },

    tasksToRecs : function(tasks) {

        return _.map( tasks, function(task) {

            return {
                // "user" : task.get("Owner") ? task.get("Owner")._refObjectName : "none",
                "user" : task.get("FormattedID"),
                "project" : task.get("Project") ? task.get("Project")._refObjectName : "none",
                "iteration" : task.get("Iteration") ? task.get("Iteration")._refObjectName : "none",
                "task" : task.get("Name") ? task.get("Name") : "none",
                "estimate" : task.get("Estimate") ? task.get("Estimate") : 0,
                "todo" : task.get("ToDo") ? task.get("ToDo") : 0,
                "actuals" : task.get("Actuals") ? task.get("Actuals") : 0,
                leaf : true
            };
        });
    },

    addTreeGrid : function() {

        var items = {
            "text" : ".",
            children : []
        }

        // group the tasks by owner, project and iteration
        var g = _.groupBy(app.tasks,function(t) { return t.get("Owner") ? t.get("Owner")._refObjectName:"none";});
        _.each( _.keys(g),function(okey){
            var byOwner = g[okey];
            var rec = {"user": okey, children: [] };

            var gProjects = _.groupBy( byOwner, function(t) { return t.get("Project") ? t.get("Project")._refObjectName:"none";});  
            _.each( _.keys(gProjects),function(pKey) {
                var byProject = gProjects[pKey];
                var pRec = {user:pKey, children: []};

                var gIterations = _.groupBy( byProject, function(t) { return t.get("Iteration") ? t.get("Iteration")._refObjectName:"none";});  
                _.each( _.keys(gIterations),function(iKey) {
                    var byIteration = gIterations[iKey];
                    var iRec = {user:iKey,children:app.tasksToRecs(byIteration)};
                    pRec.children.push(iRec);
                    // for iterations we look up the capacity
                    var icapacity = _.find(app.capacities,function(ac) {
                        return ac.get("User")._refObjectName == okey &&
                                ac.get("Project")._refObjectName == pKey &&
                                ac.get("Iteration")._refObjectName == iKey;
                    });
                    iRec["capacity"] = icapacity ? icapacity.get("Capacity") : 0;
                });
                rec.children.push(pRec);
            });
            items.children.push(rec);
        });

        var sumLevelForKey = function( node, key) {
            var t = traverse(node).reduce( function(acc,y) {
                if (this.key == key) acc += y;
                return acc;
            },0);
            node[key] = t;
        };

        // use the traverse function to sum by level
        traverse(items).forEach(function (x) {
            // console.log("x",x,this.level,this.parent ?this.parent.level:"");
            if (this.level===6 || this.level===4 || this.level===2) {
                sumLevelForKey(x,"estimate");
                sumLevelForKey(x,"todo");
                sumLevelForKey(x,"actuals");
            }
            if (this.level===2 || this.level===4) {
                sumLevelForKey(x,"capacity");   
            }

        });        

        //we want to setup a model and store instead of using dataUrl
        Ext.define('TreeTask', {
            extend: 'Ext.data.Model',
            fields: [
                {name: 'user',     type: 'string'},
                {name: 'task',     type: 'string'},
                {name: 'capacity', type: 'number'},
                {name: 'estimate', type: 'number'},
                {name: 'todo',     type: 'number'},
                {name: 'actuals',  type: 'number'}
            ]
        });

        var store = Ext.create('Ext.data.TreeStore', {
            model: 'TreeTask',
            proxy : {
                type : 'memory'
            },
            foldersort : true
        });

        var rootNode = store.setRootNode(items);

        if (app.tree)
            app.tree.destroy();

        //Ext.ux.tree.TreeGrid is no longer a Ux. You can simply use a tree.TreePanel
        app.tree = Ext.create('Ext.tree.Panel', {
            title: 'Release Team Status',
            width: 600,
            height: 300,
            collapsible: true,
            useArrows: true,
            rootVisible: false,
            store: store,
            multiSelect: true,
            singleExpand: false,
            //the 'columns' property is now 'headers'
            columns: [{
                xtype: 'treecolumn', //this is so we know which column will show the tree
                text: 'Owner',
                flex: 2,
                sortable: true,
                dataIndex: 'user',
                width:200
            },
                { text: 'Task', flex: 1, dataIndex: 'task', sortable: true},
                { text: 'Capacity', flex: 1, dataIndex: 'capacity', align:'right', sortable: true,renderer:app.renderNumber},
                { text: 'Estimate', flex: 1, dataIndex: 'estimate', align:'right',sortable: true,renderer:app.renderNumber},
                { text: 'ToDo', flex: 1, dataIndex: 'todo', align:'right',sortable: true,renderer:app.renderNumber},
                { text: 'Actuals', flex: 1, dataIndex: 'actuals', align:'right',sortable: true,renderer:app.renderNumber}
            ]
        });
    
        app.add(app.tree);

    },

    renderNumber : function(v) { 
        return v > 0 ? v : "";
    }

    
});
