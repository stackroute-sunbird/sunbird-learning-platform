#!/usr/bin/env node

/**

Usage:
node ItemImporterv3.js --help

-d 	dry run
-u  user id
-e  environment (prod, qa, dev, sandbox)
-f  items csv
-m  mappings json
-a  assets csv
-k  api key
-p partial update

Successful record identifiers are written to success.json file
Errors are written to output.json file

Example:

MMCQs
node ItemImporterv3.js -e dev -u 128 -f test_v2_mmcq.csv -m mcq_mapping_v2.json -k xxxxxx

FTBs
node ItemImporterv3.js -e dev -u 128 -f test_v2_ftb.csv -m ftb_mapping_v2.json -k xxxxxx

MTFs
node ItemImporterv3.js -e dev -u 128 -f test_v2_mtf.csv -m mtf_mapping_v2.json -k xxxxxx

**/

var csv = require('csv');
var fs = require('fs');
var _ = require('underscore');
var async = require('async');
var Client = require('node-rest-client').Client;
var cli = require('cli');
/**
 * Command line options to the importer
 */
var options = cli.parse({
    dryrun: ['d', 'Dry run (parse the items csv and print to console).'],
    user: ['u', 'Your user id (will show in My Items view)', 'string'],
    env: ['e', 'Environment', 'string', 'qa'],
    file: ['f', 'Items csv file to process', 'file'],
    mapping: ['m', 'Mapping json file', 'file', 'mcq_mapping_v2.json'],
    assets: ['a', 'Assets csv', 'string'],
    apikey: ['k', 'API Access token (not required for dry-run)', 'string'],
    partial: ['p' 'Is Partial Update.']
});

if ((!options.file) || (!options.env) || (!options.user)) {
    cli.error("Insufficient inputs.");
    cli.fatal("   [itemimporter --help] for usage help. ");
}

if (!options.dryrun) {
    if (!options.apikey) {
        cli.error("For actual data load, the API token is mandatory. Please contact developer support if you do not have an API token");
        cli.fatal("   [itemimporter --help] for usage help. ");
    }
}

console.log();
console.log('----------------------------------------------------------------');
console.log("             Item Importer v3.0                                 ");
console.log('----------------------------------------------------------------');
console.log();

var client = new Client();

var API_ENDPOINT_QA = "https://qa.ekstep.in/api/assessment/";
var API_ENDPOINT_DEV = "https://dev.ekstep.in/api/assessment/";

var API_ENDPOINT = (options.env == 'qa' ? API_ENDPOINT_QA : API_ENDPOINT_DEV);

var CREATE_ITEM_URL = "v3/items/update/${id}";

var inputFilePath = options.file;
var mappingFile = options.mapping;
var assetsFile = options.assets;
var apikey = options.apikey;

var mapping = {};
var mappingJson = {};
var startRow = {};
var startCol = {};
var items = [];
var resultMap = {};
var errorMap = {};
var assetsMap = {};
var invalidCount = 0;
var calls = 0;

var default_qlevel = 'MEDIUM';


/**
 * Steps of execution
 */
async.waterfall([
    readMappings,
    loadAssets,
    importItems,
    printAssessmentItems,
    createAssessmentItems
], function(err, result) {
    if (err) {
        cli.error('Error: ' + err);
    }
});

// ################################################################################################
// Waterfall operations
// ################################################################################################

/**
 * Step 1 - Reads the mappings from mapping JSON file
 */
function readMappings(callback) {
    cli.info("Reading assets file");
    mapping = fs.readFileSync(mappingFile);
    mappingJson = JSON.parse(mapping);

    startRow = mappingJson['start_row'];
    startCol = mappingJson['start_col'];

    callback(null, 'ok');
}

/**
 * Step 2 - Reads the assets from csv file
 */
function loadAssets(arg1, callback) {
    cli.info("Reading assets file");
    if (assetsFile) {
        csv()
            .from.stream(fs.createReadStream(assetsFile))
            .on('record', function(row, index) {
                if (index > 0) {
                    var code = row[0];
                    var assetid = row[1];
                    var type = row[2];
                    var src = row[3];

                    if (!isEmpty(assetid)) {
                        if (!isEmpty(code)) {
                            var data = {};
                            data.code = code.trim();
                            data.assetid = assetid.trim();
                            data.src = src.trim();
                            data.type = type.trim();

                            assetsMap[code.trim()] = data;
                        }
                    }
                }

            })
            .on('end', function(count) {
                callback(null, 'ok');
            })
            .on('error', function(error) {
                console.log('Assets csv error', error);
                callback('concept csv error: ' + error);
            });
    } else {
        callback(null, 'ok');
    }
}

/**
 * Step 3 - Parse the CSV to build item data for loading
 */
function importItems(arg1, callback) {
    cli.info("Reading items csv");
    csv().from.stream(fs.createReadStream(inputFilePath))
        .on('record', function(row, index) {
            if (index >= startRow) {
                var item = {};
                getItemRecord(row, startCol, mappingJson.data, item);
                processItemRecord(row, item, index);
            }

        })

    .on('end', function(count) {
            var countBefore = items.length;
            items = _.uniq(items, false, function(p) {
                return p.metadata.identifier;
            });
            var countAfter = items.length;
            var duplicates = countBefore - countAfter;

            cli.info("Parsed total " + (count - startRow) + " records, invalid records " + invalidCount + ", duplicates " + duplicates);
            callback(null, 'ok');
        })
        .on('error', function(error) {
            cli.error('Import item error', error);
            callback('Import item error: ' + error);
        });
}

/**
 * Step 4 - DRY RUN - Prints item data to console
 */
function printAssessmentItems(arg1, callback) {
    if (options.dryrun) {
       console.log('----------------------------------------------------------------');

        cli.info("Dry Run - Printing results");
        console.log();

        if (items.length > 0) {
            var asyncFns = [];
            items.forEach(function(item) {
                var metadata = JSON.stringify(item.metadata);
                console.log();
            });
        }
    }
    callback(null, 'ok');
}

/**
 * Step 5 - Actual - Makes the API calls to load the item data
 */
function createAssessmentItems(arg1, callback) {
    if (!options.dryrun) {
        cli.info("Loading " + items.length + " items");
        if (items.length > 0) {
            var asyncFns = [];
            console.log();

            items.forEach(function(item) {
                var metadata = item.metadata;
                asyncFns.push(getMWAPICallfunction(item));
            });

            if (asyncFns.length > 0) {
                async.parallelLimit(asyncFns, 10, function() {
                    finished();
                });
            }
        }
    }
    callback(null, 'ok');
}

/**
 * Step 6 - Final summary - after all items are loaded, prints the summary
 */
function finished(arg1, result) {
    console.log();

    var successCount = 0;
    var errorCount = 0;

    if (resultMap) {
        successCount = _.keys(resultMap).length;
        if (successCount > 0) {
            cli.info('Successfully loaded ' + successCount + ' items. See success.json for details');
            var fd = fs.openSync('success.json', 'w');
            fs.writeSync(fd, JSON.stringify(resultMap));
            cli.info("Saved the results to success.json");
        }
    }

    if (errorMap) {
        errorCount = _.keys(errorMap).length;
        if (errorCount > 0) {
            cli.error("Failed to create/update " + errorCount + " items");
            for (var e in errorMap) {
                cli.error('Row ' + e + ' -> ' + JSON.stringify(errorMap[e]));
            }

            var fd = fs.openSync('output.json', 'w');
            fs.writeSync(fd, JSON.stringify(errorMap));
        }
    }

    console.log();
    console.log('----------------------------------------------------------------');
    if (errorCount == 0) cli.ok('Completed! All items loaded/parsed successfully');
    else cli.error('Completed! There were errors. See the logs above for error descriotions');
    console.log('----------------------------------------------------------------');
    console.log();
}

// ################################################################################################
// Item data processing
// ################################################################################################

/**
 * Updates the item record that has been parsed from CSV, sets default fields, shuffles options.
 */
function processItemRecord(row, item, index) {

    // Default fields
    console.log(JSON.stringify(item));
    item['rownum'] = index;
    item['portalOwner'] = '' + options.user;
    item['language'] = [item['language']];
    item['name'] = item['title']; // name is same as title
    item['description'] = item['description'];
    item['gradeLevel'] = [item['gradeLevel']]; // value of grade level is an array

    if (isEmpty(item['identifier'])) {
        item['identifier'] = item['code'];
    }
    if (isEmpty(item['qlevel'])) {
        item['qlevel'] = default_qlevel;
    }

    if (item['type'] == 'ftb') {
        // sets response for ftbs
        setFtbResponse(row, mappingJson.data, item);

        // process answers for the ftb item
        processAnswers(item);
    } else if (item['type'] == 'mcq') {
        // sets response for mcqs
        setMcqResponse(row, mappingJson.data, item, index);

        // De-dup and Shuffle options before loading
        item['options'] = processOptions(item['options']);

    } else if (item['type'] == 'mtf') {
        // sets responses for mtfs
        setMtfResponse(row, mappingJson.data, item, index);

        // Shuffle RHS options (LHS options are not shuffled otherwise answer mappings will become wrong)
        item['lhs_options'] = processOptions(item['lhs_options'], false);
        item['rhs_options'] = processOptions(item['rhs_options'], true);
    }

    // Validate if the data is correct
    var resp = validateQuestion(item);
    if (resp == 'OK' || options.partial) {
        items.push({ 'index': index, 'row': row, 'metadata': item, 'conceptIds': item.conceptIds });
    } else {
        invalidCount++;
        cli.error("Invalid question data [Row: " + index + ", Code: " + item['code'] + "] - " + resp);
    }
}

/**
 * Validates the questions - mandatory fields are presnet. Returns true if item is valid
 */
function validateQuestion(item) {
    if (item['type'] == 'mcq') {
        if (item.options.length < 2) return 'Too few options';
    } else if (item['type'] == 'mtf') {
        if (item.lhs_options.length < 1) return 'Too few options';
        if (item.rhs_options.length < 2) return 'Too few options';
    } else if (item['type'] == 'ftb') {
        if (item.num_answers < 1) return 'Too few answers';
    } else return 'Invalid item type'

    if (!item.code) return 'Missing code';
    if (!item.title) return 'Missing title';
    if (!item.template) return 'Missing template name';
    if (!item.template_id) return 'Missing template id';

    if (!processAssets(item)) return 'Missing assets';
    return 'OK';
}

/**
 * Prepares the assets before loading the item
 */
function processAssets(item) {
    var media = item.media;
    var success = true;
    // Set the src from assets map
    _.each(media, function(m, index) {
        if (m.id) {
            var mobj = assetsMap[m.id];
            if (typeof mobj != 'undefined') {
                m.src = mobj.src;
                m.asset_id = mobj.assetid;
            } else {
                success = false;
            }
        }
    });
    // src is a must have
    media = _.reject(media, function(m) {
        return m.src == null
    });
    item.media = media;
    return success;
}

/**
 * Prepares the options before loading - sets asset (for resvalue), de-dupes options & shuffles them
 */
function processOptions(options, shuffle) {
    _.each(options, function(option, index) {
        if (typeof option.value.text != 'undefined') option.value.asset = option.value.text;
        else if (typeof option.value.image != 'undefined') option.value.asset = option.value.image;
    });

    options = _.uniq(options, false, function(p) {
        return p.value.asset;
    });
    options = _.reject(options, function(p) {
        return p.value.asset == null
    }); // reject all blank options
    if (shuffle) options = _.shuffle(options);

    // TODO - Validate that MCQ has at-least one correct answer
    // TODO - Validate that MTF has all answers within LHS indices (no invalid index)
    return options;
}

/**
 * Processes the FTB answers and removes any answers that are null (CSV may have more blanks)
 */
function processAnswers(item) {
    var count = 0;
    var answer = {};

    _.each(item.answers, function(ans, index) {
        if (typeof ans != 'undefined') {
            answer['ans' + (index + 1)] = ans.trim();
            count++;
        }
    });

    item['num_answers'] = count;
    item['answer'] = answer;
    delete item.answers;
}

// ################################################################################################
// API call and response
// ################################################################################################


/**
 * Returns the function to load the item in the middleware. This is called using async.parallelLimit
 */
function getMWAPICallfunction(item) {
    var returnFn = function(callback) {
        var reqBody = { "request": { "skipValidations": false, "assessment_item": {} } };
        reqBody.request.assessment_item.identifier = item.metadata.code;
        reqBody.request.assessment_item.objectType = "AssessmentItem";
        reqBody.request.assessment_item.metadata = item.metadata;
        if (options.partial) {
          reqBody.request.skipValidations = true;
        }
        var conceptIds = item.conceptIds;
        if (_.isArray(conceptIds) && conceptIds.length > 0) {
            reqBody.request.assessment_item.outRelations = [];
            conceptIds.forEach(function(cid) {
                reqBody.request.assessment_item.outRelations.push({ "endNodeId": cid, "relationType": "associatedTo" });
            });
        }

        var authheader = 'Bearer ' + apikey;

        var args = {
            path: { id: item.metadata.code, tid: 'domain' },
            headers: {
                "Content-Type": "application/json",
                "user-id": 'csv-import',
                "Authorization": authheader
            },
            data: reqBody,
            requestConfig: {
                timeout: 240000
            },
            responseConfig: {
                timeout: 240000
            }
        };
        var url = API_ENDPOINT + CREATE_ITEM_URL;
        client.patch(url, args, function(data, response) {
            console.log("args :", args.data.request.assessment_item.metadata)
            parseResponse(item, data, callback);
        }).on('error', function(err) {
            errorMap[item.rownum] = "Connection error: " + err;
            callback(null, 'ok');
        });
    };
    return returnFn;
}

/**
 * Reads the API response and builds the response/error maps
 */
function parseResponse(item, data, callback) {
    cli.progress(++calls / items.length);
    var responseData;

    console.log(JSON.stringify(item));

    if (typeof data == 'string') {
        try {
            responseData = JSON.parse(data);
        } catch (err) {
            console.log('1');
            errorMap[item.index + 1] = 'API response for: ' + item.metadata.code + ' => ' + data;
        }
    } else {
        responseData = data;
    }

    if (responseData) {
        if (responseData.params) {
            if (responseData.params.status == 'failed') {
                var error = { 'error': responseData.params.errmsg };
                if (responseData.result && responseData.result.messages) {
                    error.messages = responseData.result.messages;
                }
                errorMap[item.metadata.rownum] = error;
            } else {
                resultMap[item.metadata.code] = responseData.result.node_id;
            }
        } else {
            console.log('2');
            errorMap[item.index + 1] = 'API response for: ' + item.metadata.code + ' => ' + data.message;
        }
    } else {
        console.log('3');
        errorMap[item.index + 1] = 'API response for: ' + item.metadata.code + ' => ' + data;
    }
    callback(null, 'ok');
}

// ################################################################################################
// CSV parser functions
// ################################################################################################

/**
 * Parses the CSV to return the item data for the given row, using the mapping definitions
 */
function getItemRecord(row, startCol, mapping, item) {

    for (var x in mapping) {
        var data = mapping[x];
        if (_.isArray(data)) {
            item[x] = [];
            getArrayData(row, startCol, data, item[x]);
        } else {
            if (data['col-def']) {
                var val = getColumnValue(row, startCol, data['col-def']);
                if (null != val)
                    item[x] = val;
            } else if (data['literal'] !== undefined) {
                var val = data['literal'];
                if (null != val)
                    item[x] = val;
            } else if (_.isObject(data)) {
                item[x] = {};
                getObjectData(row, startCol, data, item[x]);
            }
        }
    }
}
/**
 * sets possible responses for mcqs from the csv
 */
function setMcqResponse(row, mapping, item, index) {
    var result = [];
    var response_start_col = mapping.start;
    var options = item['options'];
    _.each(options, function(obj, index) {
        if (typeof obj.value.text != 'undefined') {
            obj.value.resValue = obj.value.text;
            obj.value.index = index
        } else if (typeof obj.value.image != 'undefined') {
            obj.value.resValue = obj.value.image;
            obj.value.index = index
        }
    });
    var data = {};
    _.each(options, function(obj) {
        data[obj.value.index] = obj.value.resValue;
    });
    temp = [];
    for (var x in mapping) {
        if (response_start_col < row.length) {
            var value = {};
            if (row[response_start_col] != null) {
                temp = row[response_start_col].split(',');
                _.each(temp, function(obj) {
                    value[data[obj.trim()]] = "true";
                });
                if (data[row[response_start_col + 1]] != null) {
                    value[data[row[response_start_col + 1]]] = "false";
                }
                var resp = {
                    values: value,
                    score: row[response_start_col + 2],
                    mmc: [row[response_start_col + 3]]
                }
                result.push(resp)
            }
        }
        response_start_col = response_start_col + 4;
    }
    item.responses = result;
}
/**
 * sets possible responses for ftbs from the csv
 */
function setFtbResponse(row, mapping, item) {
    var result = [];
    var response_start_col = mapping.start;
    var temp = [];
    for (var x in mapping) {
        var value = {};
        if (response_start_col < row.length) {
            if (row[response_start_col] != null) {
                temp = row[response_start_col].split(',');
                var a = 1;
                for (a in temp) {
                    value["ans" + a] = temp[a];
                }
                var resp = {
                    values: value,
                    score: row[response_start_col + 1],
                    mmc: [row[response_start_col + 2]]
                }
                result.push(resp)
            }
        }
        response_start_col = response_start_col + 3;
    }
    item.responses = result;
}
/**
 * sets possible responses for Mtfs from the csv
 */
function setMtfResponse(row, mapping, item, index) {
    var result = [];
    var rhs = [];
    var response_start_col = mapping.start;
    var rhs_options = item['rhs_options'];
    var lhs_options = item['lhs_options'];
    var lhs = {};

    // setting resValue and index for rhs_options
    _.each(rhs_options, function(obj, index) {
        if (obj.value.resValue != null) {
            rhs.push(obj.value.resValue)
            obj.value.index = index
        } else if (typeof obj.value.text != 'undefined') {
            obj.value.resValue = obj.value.text;
            rhs.push(obj.value.resValue)
            obj.value.index = index
        } else if (typeof obj.value.image != 'undefined') {
            obj.value.resValue = obj.value.image;
            rhs.push(obj.value.resValue)
            obj.value.index = index
        }
    });
    // setting resValue and index for lhs_options
    _.each(lhs_options, function(obj, index) {
        if (obj.value.resValue != null) {
            lhs[obj.index] = obj.value.resValue;
            obj.index = index
        } else if (typeof obj.value.text != 'undefined') {
            obj.value.resValue = obj.value.text;
            lhs[obj.index] = obj.value.resValue;
            obj.index = index
        } else if (typeof obj.value.image != 'undefined') {
            obj.value.resValue = option.value.image;
            lhs[obj.index] = obj.value.resValue;
            obj.index = index

        }
    });
    var temp = {};
    for (var x in mapping) {
        if (response_start_col < row.length) {
            var value = {};
            if (row[response_start_col] != null) {
                var data = {};
                data[rhs[0]] = lhs[row[response_start_col]],
                    data[rhs[1]] = lhs[row[response_start_col + 1]],
                    data[rhs[2]] = lhs[row[response_start_col + 2]],
                    data[rhs[3]] = lhs[row[response_start_col + 3]]
            }
            var temp = {
                values: data,
                score: row[response_start_col + 4],
                mmc: [row[response_start_col + 5]]
            }
            result.push(temp)
        }
        response_start_col = response_start_col + 6;
    }
    item.responses = result;
}
/**
 * Inner parser for nested JSON objects (e.g option)
 */
function getObjectData(row, startCol, obj, objData) {
    for (var k in obj) {
        var data = obj[k];
        if (data['col-def']) {
            var val = getColumnValue(row, startCol, data['col-def']);
            if (null != val)
                objData[k] = val;
        } else if (data['literal'] !== undefined) {
            var val = data['literal'];
            if (null != val)
                objData[k] = val;
        } else if (_.isObject(data)) {
            objData[k] = {};
            getObjectData(row, startCol, data, objData[k]);
        }
    }
}

/**
 * Inner parser for nested arrays (e.g. options array)
 */
function getArrayData(row, startCol, arr, arrData) {
    arr.forEach(function(data) {
        if (data['col-def']) {
            var val = getColumnValue(row, startCol, data['col-def']);
            if (null != val)
                arrData.push(val);
        } else if (_.isObject(data)) {
            var objData = {};
            getObjectData(row, startCol, data, objData);
            var add = false;
            for (var k in objData) {
                if (!isEmptyObject(objData[k])) {
                    add = true;
                }
            }
            if (add) {
                arrData.push(objData);
            }
        }
    });
}

/**
 * Returns the value in current row * column (current cell) using the mapping.
 */
function getColumnValue(row, startCol, colDef) {
    var col = colDef.column;
    var result;
    if (_.isArray(col)) {
        var data = [];
        col.forEach(function(c) {
            var val = _getValueFromRow(row, startCol, c, colDef);
            if (null != val) {
                data.push(val);
            }
        });
        return data.length > 0 ? data : null;
    } else {
        return _getValueFromRow(row, startCol, col, colDef);
    }
}

/**
 * Internal parser method to look at the col-def and read the cell value
 */
function _getValueFromRow(row, startCol, col, def) {
    var index = col + startCol;
    var data = row[index];

    if (data && data != null) {
        if (def.type == 'boolean') {
            var val = data.trim().toLowerCase();
            if (val == 'yes' || val == 'true') {
                return true;
            } else {
                return false;
            }
        } else if (def.type == 'list') {
            data = data.split(',');
            data = data.map(function(e) {
                return e.trim();
            });
            return data;
        } else if (def.type == 'number') {
            if (_.isFinite(data)) {
                data = parseFloat(data);
                return data;
            }
        }
    }

    return (data && data != null) ? data.trim() : null;
}

/**
 * Utility method that validates if the object is empty
 */
function isEmptyObject(obj) {
    if (_.isEmpty(obj)) {
        return true;
    } else {
        for (var k in obj) {
            if (_.isObject(obj[k])) {
                return isEmptyObject(obj[k]);
            } else {
                if (isEmpty(obj[k])) {
                    return true;
                }
            }
        }
    }
    return false;
}

/**
 * Utility method that returns true if we are in a toy shop
 */
function isEmpty(val) {
    if (val == null) {
        return true;
    } else {
        if (_.isString(val) && val.trim().length <= 0)
            return true;
    }
    return false;
}

/**
 * Returns the number of keys in the object
 */
function getNumberOfKeys(obj) {
    var count = 0;
    for (var prop in obj) {
        count++;
    }
    return count;
}