/* eslint-disable no-console */

var express = require('express');
var app = express();
var MBTiles = require('mbtiles');
var q = require('d3-queue').queue();
var utils = require('./utils');
var objectAssign = require('object-assign');

var zlib = require('./node-zlib');
var pbf = require('pbf');
var fs = require('fs');
var VectorTile = require('vector-tile').VectorTile;
var vtpbf = require('vt-pbf');

var bodyParser = require('body-parser');

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');
app.use(express.static('public'));



module.exports = {

    /**
     * Load a tileset and return a reference with metadata
     * @param {object} file reference to the tileset
     * @param {function} callback that returns the resulting tileset object
     */
    loadTiles: function (file, callback) {
        new MBTiles(file, function (err, tiles) {
            if (err) throw err;
            tiles.getInfo(function (err, info) {
                if (err) throw err;

                var tileset = objectAssign({}, info, {
                    tiles: tiles
                });

                callback(null, tileset);
            });
        });
    },

    /**
    * Defer loading of multiple MBTiles and spin up server.
    * Will merge all the configurations found in the sources.
    * @param {object} config for the server, e.g. port
    * @param {function} callback with the server configuration loaded
    */
    serve: function (config, callback) {
        var loadTiles = this.loadTiles;
        var listen = this.listen;

        config.mbtiles.forEach(function (file) {
            q.defer(loadTiles, file);
        });

        q.awaitAll(function (error, tilesets) {
            if (error) throw error;
            // if (!config.quiet) {
            //   console.log('*** Config', config);
            //   console.log('*** Metadata found in the MBTiles');
            //   console.log(tilesets);
            // }

            var finalConfig = utils.mergeConfigurations(config, tilesets);
            listen(finalConfig, callback);
        });
    },

    listen: function (config, onListen) {
        app.get('/', function (req, res) {
            res.render('map', config);
        });

        app.get('/:source/:z/:x/:y.pbf', function (req, res) {
            var p = req.params;

            var tiles = config.sources[p.source].tiles;
            tiles.getTile(p.z, p.x, p.y, function (err, tile, headers) {
                if (err) {
                    res.end();
                } else {
                    res.writeHead(200, headers);
                    res.end(tile);
                }
            });
        });

        // v0.0.1 动态修改切片的接口
        app.post('/:source/:vector_layers/:z/:x/:y.pbf', function (req, res) {
            var startTime = new Date().getTime();
            var p = req.params;
            var q = req.query;
            var r = req.body;

            var tiles = config.sources[p.source].tiles;

            // 查询的唯一键，id，根据这个字段去查询
            var queryKey = Object.keys(q);

            // 这个是所有需要修改的所有键的数组，所有前台传过来的需要修改的字段和值
            var editKeys = Object.keys(r);

            tiles.getTile(p.z, p.x, p.y, function (err, tile, headers) {
                if (err) {
                    res.end();
                } else {
                    //res.writeHead(200, headers);
                    zlib.gunzip(tile, function (err, buffer) {
                        err && console.dir(err);

                        var vectorTileContent = new VectorTile(new pbf(buffer)),
                            values = vectorTileContent['layers'][p.vector_layers]['_values'],
                            valueLength = values.length,
                            keys = vectorTileContent['layers'][p.vector_layers]['_keys'],
                            keysLength = keys.length,
                            valuesIndex = keys.indexOf(queryKey[0]);

                        // 循环遍历values里面的所有value
                        // 这里是遍历了keys倍数的values
                        for (; valuesIndex < valueLength; valuesIndex += keysLength) {
                            if (values[valuesIndex] == q[queryKey[0]]) {
                                editKeys.forEach(function (editKey) {
                                    values[valuesIndex + (keys.indexOf(queryKey[0]) - keys.indexOf(editKey))] = r[editKey];
                                })
                            }
                        }

                        zlib.gzip(vtpbf(vectorTileContent), function (err, ss) {
                            tiles.changeTile(p.z, p.x, p.y, ss, function (err, result) {
                                if (err) {
                                    console.log(err);
                                    res.json({
                                        "status": 0,
                                        "message": "error"
                                    });
                                } else {
                                    // console.log('===============================================================');
                                    // console.dir(vectorTileContent.layers[p.vector_layers]._values);
                                    // console.log(((new Date()).getTime()) - startTime);
                                    res.json({
                                        "status": 1,
                                        "message": "success"
                                    });
                                }
                            });
                        });
                    });
                }
            });
        });

        config.server = app.listen(config.port, function () {
            onListen(null, config);
        });
    }

};
