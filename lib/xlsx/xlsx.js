/**
 * Copyright (c) 2014 Guyon Roche
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the 'Software'), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */
'use strict';

var fs = require('fs');
var ZipStream = require('../utils/zip-stream');
var StreamBuf = require('../utils/stream-buf');
var PromishLib = require('../utils/promish');

var utils = require('../utils/utils');
var XmlStream = require('../utils/xml-stream');

var StylesXform = require('./xform/style/styles-xform');

var CoreXform = require('./xform/core/core-xform');
var SharedStringsXform = require('./xform/strings/shared-strings-xform');
var RelationshipsXform = require('./xform/core/relationships-xform');
var ContentTypesXform = require('./xform/core/content-types-xform');
var AppXform = require('./xform/core/app-xform');
var WorkbookXform = require('./xform/book/workbook-xform');
var WorksheetXform = require('./xform/sheet/worksheet-xform');

var theme1Xml = require('./xml/theme1.xml.js');

var XLSX = module.exports = function (workbook) {
  this.workbook = workbook;
};


XLSX.RelType = require('./rel-type');


XLSX.prototype = {

// ===============================================================================
// Workbook
  // =========================================================================
  // Read

  readFile: function (filename) {
    var self = this;
    var stream;
    return utils.fs.exists(filename)
      .then(function (exists) {
        if (!exists) {
          throw new Error('File not found: ' + filename);
        }
        stream = fs.createReadStream(filename);
        return self.read(stream);
      })
      .then(function (workbook) {
        stream.close();
        return workbook;
      });
  },
  parseRels: function (stream) {
    var xform = new RelationshipsXform();
    return xform.parseStream(stream);
  },
  parseWorkbook: function (stream) {
    var xform = new WorkbookXform();
    return xform.parseStream(stream);
  },
  parseSharedStrings: function (stream) {
    var xform = new SharedStringsXform();
    return xform.parseStream(stream);
  },
  reconcile: function (model) {
    var workbookXform = new WorkbookXform();
    var worksheetXform = new WorksheetXform();
    
    workbookXform.reconcile(model);
    var sheetOptions = {
      styles: model.styles,
      sharedStrings: model.sharedStrings,
      date1904: model.properties.date1904
    };
    model.worksheets.forEach(function (worksheet) {
      worksheet.relationships = model.worksheetRels[worksheet.sheetNo];
      worksheetXform.reconcile(worksheet, sheetOptions);
    });

    // delete unnecessary parts
    model.worksheetHash = undefined;
    model.worksheetRels = undefined;
    model.globalRels = undefined;
    model.sharedStrings = undefined;
    model.workbookRels = undefined;
    model.sheetDefs = undefined;
    model.styles = undefined;
  },
  processWorksheetEntry: function(entry, model) {
    var match = entry.path.match(/xl\/worksheets\/sheet(\d+)\.xml/);
    if (match) {
      var sheetNo = match[1];
      var xform = new WorksheetXform();
      return xform.parseStream(entry)
        .then(function (worksheet) {
          worksheet.sheetNo = sheetNo;
          model.worksheetHash[entry.path] = worksheet;
          model.worksheets.push(worksheet);
        });
    }
  },
  processWorksheetRelsEntry: function(entry, model) {
    var match = entry.path.match(/xl\/worksheets\/_rels\/sheet(\d+)\.xml.rels/);
    if (match) {
      var sheetNo = match[1];
      var xform = new RelationshipsXform();
      return xform.parseStream(entry)
        .then(function(relationships) {
          model.worksheetRels[sheetNo] = relationships;
        });
    }
  },
  processThemeEntry: function(entry, model) {
    var match = entry.path.match(/xl\/theme\/([a-zA-Z0-9]+)\.xml/);
    if (match) {
      return new PromishLib.Promish(function(resolve, reject) {
        var name = match[1];
        // TODO: stream entry into buffer and store the xml in the model.themes[]
        var stream = new StreamBuf();
        entry.on('error', reject);
        stream.on('error', reject);
        stream.on('finish', function() {
          model.themes[name] = stream.read().toString();
          resolve();
        });
        entry.pipe(stream);
      });
    }
  },
  processIgnoreEntry: function(entry) {
    entry.autodrain();
  },
  createInputStream: function () {
    var self = this;
    var model = {
      worksheets: [],
      worksheetHash: {},
      worksheetRels: [],
      themes: {},
    };

    // we have to be prepared to read the zip entries in whatever order they arrive
    var promises = [];
    var stream = new ZipStream.ZipReader();
    stream.on('entry', function (entry) {
      var promise = null;

      var entryPath = entry.path;
      if (entryPath[0] === '/') {
        entryPath = entryPath.substr(1);
      }
      switch (entryPath) {
        case '_rels/.rels':
          promise = self.parseRels(entry)
            .then(function (relationships) {
              model.globalRels = relationships;
            });
          break;

        case 'xl/workbook.xml':
          promise = self.parseWorkbook(entry)
            .then(function (workbook) {
              model.sheets = workbook.sheets;
              model.definedNames = workbook.definedNames;
              model.views = workbook.views;
              model.properties = workbook.properties;
            });
          break;

        case 'xl/_rels/workbook.xml.rels':
          promise = self.parseRels(entry)
            .then(function (relationships) {
              model.workbookRels = relationships;
            });
          break;

        case 'xl/sharedStrings.xml':
          model.sharedStrings = new SharedStringsXform();
          promise = model.sharedStrings.parseStream(entry);
          break;

        case 'xl/styles.xml':
          model.styles = new StylesXform();
          promise = model.styles.parseStream(entry);
          break;

        case 'docProps/app.xml':
          var appXform = new AppXform();
          promise = appXform.parseStream(entry)
            .then(function(appProperties) {
              Object.assign(model, {
                company: appProperties.company,
                manager: appProperties.manager
              });
            });
          break;

        case 'docProps/core.xml':
          var coreXform = new CoreXform();
          promise = coreXform.parseStream(entry)
            .then(function(coreProperties) {
              Object.assign(model, coreProperties);
            });
          break;

        default:
          promise =
            self.processWorksheetEntry(entry, model) ||
            self.processWorksheetRelsEntry(entry, model) ||
            self.processThemeEntry(entry, model) ||
            self.processIgnoreEntry(entry);
          break;
      }

      if (promise) {
        promises.push(promise);
        promise = null;
      }
    });
    stream.on('finished', function () {
      PromishLib.Promish.all(promises)
        .then(function () {
          self.reconcile(model);

          // apply model
          self.workbook.model = model;
        })
        .then(function () {
          stream.emit('done');
        })
        .catch(function (error) {
          stream.emit('error', error);
        });
    });
    return stream;
  },

  read: function (stream) {
    var self = this;
    var zipStream = this.createInputStream();
    return new PromishLib.Promish(function(resolve, reject) {
      zipStream.on('done', function () {
        resolve(self.workbook);
      }).on('error', function (error) {
        reject(error);
      });
      stream.pipe(zipStream);
    });
  },

  load: function(data, options) {
    var self = this;
    if (options === undefined) {
      options = {};
    }
    var zipStream = this.createInputStream();
    return new PromishLib.Promish(function(resolve, reject) {
      zipStream.on('done', function () {
        resolve(self.workbook);
      }).on('error', function (error) {
        reject(error);
      });

      if (options.base64) {
        var buffer = new Buffer(data.toString(), 'base64');
        zipStream.write(buffer);
      } else {
        zipStream.write(data);
      }
      zipStream.end();
    });
  },

  // =========================================================================
  // Write

  addContentTypes: function (zip, model) {
    return new PromishLib.Promish(function(resolve) {
      var xform = new ContentTypesXform();
      var xml = xform.toXml(model);
      zip.append(xml, {name: '[Content_Types].xml'});
      resolve();
    });
  },

  addApp: function (zip, model) {
    return new PromishLib.Promish(function(resolve) {
      var xform = new AppXform();
      var xml = xform.toXml(model);
      zip.append(xml, {name: 'docProps/app.xml'});
      resolve();
    });
  },

  addCore: function (zip, model) {
    return new PromishLib.Promish(function(resolve) {
      var coreXform = new CoreXform();
      zip.append(coreXform.toXml(model), {name: 'docProps/core.xml'});
      resolve();
    });
  },

  addThemes: function (zip, model) {
    return new PromishLib.Promish(function(resolve) {
      var themes = model.themes || { theme1: theme1Xml };
      Object.keys(themes).forEach(function(name) {
        var xml = themes[name];
        var path = 'xl/theme/' + name + '.xml';
        console.log('adding theme', path);
        zip.append(xml, {name: path});
      });
      resolve();
    });
  },

  addOfficeRels: function (zip) {
    return new PromishLib.Promish(function(resolve) {
      var xform = new RelationshipsXform();
      var xml = xform.toXml([
          {rId: 'rId1', type: XLSX.RelType.OfficeDocument, target: 'xl/workbook.xml'}
        ]);
      zip.append(xml, {name: '_rels/.rels'});
      resolve();
    });
  },

  addWorkbookRels: function (zip, model) {
    var count = 1;
    var relationships = [
        {rId: 'rId' + (count++), type: XLSX.RelType.Styles, target: 'styles.xml'},
        {rId: 'rId' + (count++), type: XLSX.RelType.Theme, target: 'theme/theme1.xml'}
    ];
    if (model.sharedStrings.count) {
      relationships.push(
        {rId: 'rId' + (count++), type: XLSX.RelType.SharedStrings, target: 'sharedStrings.xml'}
      );
    }
    model.worksheets.forEach(function (worksheet) {
      worksheet.rId = 'rId' + (count++);
      relationships.push(
        {rId: worksheet.rId, type: XLSX.RelType.Worksheet, target: 'worksheets/sheet' + worksheet.id + '.xml'}
      );
    });
    return new PromishLib.Promish(function(resolve) {
      var xform = new RelationshipsXform();
      var xml = xform.toXml(relationships);
      zip.append(xml, {name: 'xl/_rels/workbook.xml.rels'});
      resolve();
    });
  },
  addSharedStrings: function (zip, model) {
    if (!model.sharedStrings || !model.sharedStrings.count) {
      return PromishLib.Promish.resolve();
    } else {
      return new PromishLib.Promish(function(resolve) {
        zip.append(model.sharedStrings.xml, {name: 'xl/sharedStrings.xml'});
        resolve();
      });
    }
  },
  addStyles: function(zip, model) {
    return new PromishLib.Promish(function(resolve) {
      var xml = model.styles.xml;
      if (xml) {
        zip.append(xml, {name: 'xl/styles.xml'});
      }
      resolve();
    });
  },
  addWorkbook: function (zip, model, xform) {
    return new PromishLib.Promish(function(resolve) {
      zip.append(xform.toXml(model), {name: 'xl/workbook.xml'});
      resolve();
    });
  },
  addWorksheets: function (zip, model, worksheetXform) {
    return new PromishLib.Promish(function(resolve) {

      // preparation phase
      var relationshipsXform = new RelationshipsXform();

      // write sheets
      model.worksheets.forEach(function (worksheet) {
        var xmlStream = new XmlStream();
        worksheetXform.render(xmlStream, worksheet);
        zip.append(xmlStream.xml, {name: 'xl/worksheets/sheet' + worksheet.id + '.xml'});

        if (worksheet.hyperlinks && worksheet.hyperlinks.length) {
          xmlStream = new XmlStream();
          relationshipsXform.render(xmlStream, worksheet.hyperlinks);
          zip.append(xmlStream.xml, {name: 'xl/worksheets/_rels/sheet' + worksheet.id + '.xml.rels'});
        }
      });

      resolve();
    });
  },
  _finalize: function (zip) {
    var self = this;

    return new PromishLib.Promish(function(resolve, reject) {

      zip.on('finish', function () {
        resolve(self);
      });
      zip.on('error', function (error) {
        reject(error);
      });

      zip.finalize();
    });
  },
  write: function (stream, options) {
    options = options || {};
    var self = this;
    var model = self.workbook.model;
    var zip = new ZipStream.ZipWriter();
    zip.pipe(stream);

    // ensure following properties have sane values
    model.creator = model.creator || 'ExcelJS';
    model.lastModifiedBy = model.lastModifiedBy || 'ExcelJS';
    model.created = model.created || new Date();
    model.modified = model.modified || new Date();

    model.useSharedStrings = options.useSharedStrings !== undefined ?
      options.useSharedStrings :
      true;
    model.useStyles = options.useStyles !== undefined ?
      options.useStyles :
      true;

    // Manage the shared strings
    model.sharedStrings = new SharedStringsXform();

    // add a style manager to handle cell formats, fonts, etc.
    model.styles = model.useStyles ? new StylesXform(true) : new StylesXform.Mock();

    // prepare all of the things before the render
    var workbookXform = new WorkbookXform();
    var worksheetXform = new WorksheetXform();
    var prepareOptions = {
      sharedStrings: model.sharedStrings,
      styles: model.styles,
      date1904: model.properties.date1904
    };
    workbookXform.prepare(model);
    model.worksheets.forEach(function (worksheet) {
      worksheetXform.prepare(worksheet, prepareOptions);
    });

    // render
    var promises = [
      self.addContentTypes(zip, model),
      self.addApp(zip, model),
      self.addCore(zip, model),
      self.addThemes(zip, model),
      self.addOfficeRels(zip, model)
    ];
    return PromishLib.Promish.all(promises)
      .then(function () {
        return self.addWorksheets(zip, model, worksheetXform);
      })
      .then(function () {
        // Some things can only be done after all the worksheets have been processed
        var afters = [
          self.addSharedStrings(zip, model),
          self.addStyles(zip, model),
          self.addWorkbookRels(zip, model)
        ];
        return PromishLib.Promish.all(afters);
      })
      .then(function () {
        return self.addWorkbook(zip, model, workbookXform);
      })
      .then(function () {
        return self._finalize(zip);
      });
  },
  writeFile: function (filename, options) {
    var self = this;
    var stream = fs.createWriteStream(filename);

    return new PromishLib.Promish(function(resolve, reject) {
      stream.on('finish', function () {
        resolve();
      });
      stream.on('error', function (error) {
        reject(error);
      });

      self.write(stream, options)
        .then(function () {
          stream.end();
        })
        .catch(function (error) {
          reject(error);
        });
    });
  },
  writeBuffer: function(options) {
    var self = this;
    var stream = new StreamBuf();
    return self.write(stream, options)
      .then(function() {
        return stream.read();
      });
  }
};
