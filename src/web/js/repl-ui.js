({
  requires: [
    { "import-type": "dependency",
      protocol: "js-file",
      args: ["./check-ui"]
    },
    { "import-type": "dependency",
      protocol: "js-file",
      args: ["./output-ui"]
    },
    { "import-type": "dependency",
      protocol: "js-file",
      args: ["./error-ui"]
    },
    { "import-type": "dependency",
      protocol: "js-file",
      args: ["./text-handlers"]
    },
    { "import-type": "dependency",
      protocol: "js-file",
      args: ["./repl-history"]
    },
    { "import-type": "builtin",
      name: "world-lib"
    },
    { "import-type": "builtin",
      name: "load-lib"
    }
  ],
  nativeRequires: [
    "pyret-base/js/runtime-util"
  ],
  provides: {},
  theModule: function(runtime, _, uri,
                      checkUI, outputUI, errorUI,
                      textHandlers, replHistory,
                      worldLib, loadLib,
                      util) {
    var ffi = runtime.ffi;

    var output = jQuery("<div id='output' aria-hidden='true' class='cm-s-default'>");

    var outputPending = jQuery("<span>").text("Gathering results...");
    var outputPendingHidden = true;
    var canShowRunningIndicator = false;
    var running = false;

    class Graph {
      constructor(value) {
        let xmlns = "http://www.w3.org/2000/svg";
        let svg = document.createElementNS(xmlns, "svg");

        svg.setAttributeNS(null, "viewBox", "0 0 36 36");
        svg.classList.add("circular-chart");
        svg.classList.add("blue");

        let circle = "M18 2.0845 "
                   + "a 15.9155 15.9155 0 0 1 0 31.831 "
                   + "a 15.9155 15.9155 0 0 1 0 -31.831";

        let bg = document.createElementNS(xmlns, "path");
        bg.classList.add("circle-bg");
        bg.setAttributeNS(null, 'd', circle);

        let fg = document.createElementNS(xmlns, "path");
        fg.classList.add("circle");
        fg.setAttributeNS(null, 'd', circle);
        fg.setAttributeNS(null, 'stroke-dasharray', "0, 100");

        let text = document.createElementNS(xmlns, "text");
        text.classList.add("percentage");
        text.setAttributeNS(null, 'x', "18");
        text.setAttributeNS(null, 'y', "20.35");

        this.bg = svg.appendChild(bg);
        this.fg = svg.appendChild(fg);
        this.text = svg.appendChild(text);
        this.element = svg;

        let fallback = {numerator: "none", denominator: "none"};
        this.numerator = (value || fallback).numerator;
        this.denominator = (value || fallback).denominator;
        this.value = {numerator: this.numerator, denominator: this.denominator};
      }

      set value(value){
        if (typeof value.numerator === "number" &&
            typeof value.denominator === "number")
        {
          this.numerator = value.numerator;
          this.denominator = value.denominator;
          this.fg.setAttributeNS(null, 'stroke-dasharray',
            `${(value.numerator / value.denominator) * 100}, 100`);
          this.text.innerHTML = `${value.numerator}⁄${value.denominator}`;
        } else {
          this.fg.setAttributeNS(null, 'stroke-dasharray', "0, 100");
          this.text.innerHTML = "?";
        }
      }
    }

    var RUNNING_SPINWHEEL_DELAY_MS = 1000;

    function merge(obj, extension) {
      var newobj = {};
      Object.keys(obj).forEach(function(k) {
        newobj[k] = obj[k];
      });
      Object.keys(extension).forEach(function(k) {
        newobj[k] = extension[k];
      });
      return newobj;
    }
    var animationDivs = [];
    function closeAnimationIfOpen() {
      animationDivs.forEach(function(animationDiv) {
        animationDiv.empty();
        animationDiv.dialog("destroy");
        animationDiv.remove();
      });
      animationDivs = [];
    }
    function closeTopAnimationIfOpen() {
      var animationDiv = animationDivs.pop();
      animationDiv.empty();
      animationDiv.dialog("destroy");
      animationDiv.remove();
    }

    var interactionsCount = 0;

    function formatCode(container, src) {
      CodeMirror.runMode(src, "pyret", container);
    }

    // NOTE(joe): sadly depends on the page and hard to figure out how to make
    // this less global
    function scroll(output) {
      $(".repl").animate({
           scrollTop: output.height(),
         },
         50
      );
    }

    // the result of applying `displayResult` is a function that MUST
    // NOT BE CALLED ON THE PYRET STACK.
    function displayResult(output, callingRuntime, resultRuntime, isMain, updateItems) {
      // updateItems() is used to update the repl interaction history
      //console.log('doing displayResult', isMain);
      var runtime = callingRuntime;
      var rr = resultRuntime;

      // MUST BE CALLED ON THE PYRET STACK
      function renderAndDisplayError(runtime, error, stack, click, result) {
        //console.log('renderAndDisplayError');
        //updateItems(isMain);
        var error_to_html = errorUI.error_to_html;
        // `renderAndDisplayError` must be called on the pyret stack
        // because of this call to `pauseStack`
        return runtime.pauseStack(function (restarter) {
          // error_to_html must not be called on the pyret stack
          return error_to_html(runtime, CPO.documents, error, stack, result).
            then(function (html) {
              html.on('click', function(){
                $(".highlights-active").removeClass("highlights-active");
                html.trigger('toggleHighlight');
                html.addClass("highlights-active");
              });
              html[0].setAttribute('aria-hidden', 'true');
              html.addClass('compile-error').appendTo(output);
              //updateItems?
              if (click) html.click();
              scroll(output);
            }).done(function () {
              //updateItems(isMain);
              restarter.resume(runtime.nothing)
            });
        });
      }

      // this function must NOT be called on the pyret stack
      return function(result, examplarResults) {
        console.info("DISPLAY RESULT", result, examplarResults);
        var doneDisplay = Q.defer();
        var didError = false;
        // Start a new pyret stack.
        // this returned function must not be called on the pyret stack
        // b/c `callingRuntime.runThunk` must not be called on the pyret stack
        callingRuntime.runThunk(function() {
          console.log("Full time including compile/load:", JSON.stringify(result.stats));
          if(callingRuntime.isFailureResult(result)) {
            didError = true;
            // Parse Errors
            // `renderAndDisplayError` must be called on the pyret stack
            // this application runs in the context of the above `callingRuntime.runThunk`
            return renderAndDisplayError(callingRuntime, result.exn.exn, [], true, result);
          }
          else if(callingRuntime.isSuccessResult(result)) {
            result = result.result;
            //updateItems?
            return ffi.cases(ffi.isEither, "is-Either", result, {
              left: function(compileResultErrors) {
                closeAnimationIfOpen();
                didError = true;
                // Compile Errors
                var errors = ffi.toArray(compileResultErrors).
                  reduce(function (errors, error) {
                      Array.prototype.push.apply(errors,
                        ffi.toArray(runtime.getField(error, "problems")));
                      return errors;
                    }, []);
                // `safeCall` must be called on the pyret stack
                // this application runs in the context of the above `callingRuntime.runThunk`
                return callingRuntime.safeCall(
                  function() {
                    // eachLoop must be called in the context of the pyret stack
                    // this application runs in the context of the above `callingRuntime.runThunk`
                    return callingRuntime.eachLoop(runtime.makeFunction(function(i) {
                      // `renderAndDisplayError` must be called in the context of the
                      // pyret stack.
                      return renderAndDisplayError(callingRuntime, errors[i], [], true, result);
                    }), 0, errors.length);
                  }, function (result) {
                    //updateItems(isMain);
                    return result;
                  }, "renderMultipleErrors");
              },
              right: function(v) {
                // TODO(joe): This is a place to consider which runtime level
                // to use if we have separate compile/run runtimes.  I think
                // that loadLib will be instantiated with callingRuntime, and
                // I think that's correct.
                return callingRuntime.pauseStack(function(restarter) {
                  rr.runThunk(function() {
                    var runResult = rr.getField(loadLib, "internal").getModuleResultResult(v);
                    console.log("Time to run compiled program:", JSON.stringify(runResult.stats));
                    if(rr.isSuccessResult(runResult)) {
                      return rr.safeCall(function() {
                        return checkUI.drawCheckResults(output, CPO.documents, rr,
                                                        runtime.getField(runResult.result, "checks"), v,
                                                        examplarResults);
                      }, function(_) {
                        outputPending.remove();
                        outputPendingHidden = true;
                        //updateItems(isMain);
                        return true;
                      }, "rr.drawCheckResults");
                    } else {
                      didError = true;
                      // `renderAndDisplayError` must be called in the context of the pyret stack.
                      // this application runs in the context of the above `rr.runThunk`.
                      //updateItems?
                      return renderAndDisplayError(resultRuntime, runResult.exn.exn,
                                                   runResult.exn.pyretStack, true, runResult);
                    }
                  }, function(_) {
                    restarter.resume(callingRuntime.nothing);
                  });
                });
              }
            });
          }
          else {
            //updateItems?
            doneDisplay.reject("Error displaying output");
            console.error("Bad result: ", result);
            didError = true;
            // `renderAndDisplayError` must be called in the context of the pyret stack.
            // this application runs in the context of `callingRuntime.runThunk`
            return renderAndDisplayError(
              callingRuntime,
              ffi.InternalError("Got something other than a Pyret result when running the program.",
                                ffi.makeList(result)));
          }
        }, function(_) {
          if (didError) {
            var snippets = output.find(".CodeMirror");
            for (var i = 0; i < snippets.length; i++) {
              snippets[i].CodeMirror.refresh();
            }
          }
          updateItems(isMain);
          //speakHistory(1);
          doneDisplay.resolve("Done displaying output");
          return callingRuntime.nothing;
        });
      return doneDisplay.promise;
      }
    }

    // the result of applying `displayResult` is a function that MUST
    // NOT BE CALLED ON THE PYRET STACK.
    function jsonResult(output, callingRuntime, resultRuntime, isMain) {
      var runtime = callingRuntime;
      var rr = resultRuntime;

      // this function must NOT be called on the pyret stack
      return function(result)
      {
        var base_result = result;
        var doneDisplay = Q.defer();

        // Start a new pyret stack.
        // this returned function must not be called on the pyret stack
        // b/c `callingRuntime.runThunk` must not be called on the pyret stack
        callingRuntime.runThunk(function() {
          if(callingRuntime.isFailureResult(result)) {
            // Parse Errors
            return false;
          }
          else if(callingRuntime.isSuccessResult(result)) {
            result = result.result;
            return ffi.cases(ffi.isEither, "is-Either", result, {
              left: function(compileResultErrors) {
                return false;
              },
              right: function(v) {
                // TODO(joe): This is a place to consider which runtime level
                // to use if we have separate compile/run runtimes.  I think
                // that loadLib will be instantiated with callingRuntime, and
                // I think that's correct.
                return callingRuntime.pauseStack(function(restarter) {
                  rr.runThunk(function() {
                    var runResult = rr.getField(loadLib, "internal").getModuleResultResult(v);
                    if(rr.isSuccessResult(runResult)) {
                      return rr.safeCall(function() {
                        return checkUI.jsonCheckResults(output, CPO.documents, rr,
                                                        runtime.getField(runResult.result, "checks"), v);
                      }, function(result) {
                        return result;
                      }, "rr.jsonCheckResults");
                    } else {
                      return false;
                    }
                  }, function(result) {
                    restarter.resume(result.result);
                  });
                });
              }
            });
          }
          else {
            return false;
          }
        }, function(r) {
          if (r.result instanceof Array) {
            doneDisplay.resolve({json: r.result, pyret: base_result});
          } else if (r.result === false) {
            doneDisplay.reject(base_result);
          } else {
            console.error("ERROR ENCOUNTERED", r.result);
            doneDisplay.reject(r.result);
          }
        });
  
        return doneDisplay.promise;
      }
    }

    //: -> (code -> printing it on the repl)
    function makeRepl(container, repl, runtime, options) {

      var Jsworld = worldLib;

      // a11y stuff

      function outputText(elt) {
        //console.log('outputText of', elt);
        var text;
        if (elt.classList.contains('test-results')) {
          var eltChildren = elt.childNodes;
          text = '';
          for (var i = 0; i < eltChildren.length; i++) {
            var eltI = eltChildren[i];
            if (eltI.classList.contains('testing-summary')) {
              var succ = eltI.getElementsByClassName('summary-bits');
              if (succ.length > 0) {
                text += eltI.getElementsByClassName('summary-passed')[0].innerText +
                  ', ' + eltI.getElementsByClassName('summary-failed')[0].innerText + '. ';
              } else {
                text += eltI.innerText + '. ';
              }
            } else if (eltI.classList.contains('check-block-success') ||
              eltI.classList.contains('check-block-failed')) {
              var eltIChildren = eltI.childNodes;
              for (j = 0; j < eltIChildren.length; j++) {
                var eltIJ = eltIChildren[j];
                if (!eltIJ.classList.contains('check-block-tests')) {
                  text += eltIJ.innerText + '. ';
                }
              }
            }
            else {
              text += eltI.innerText + '. ';
            }
          }
        } else {
          var ro = elt.getElementsByClassName('replOutput');
          if (ro.length === 0) ro = elt.getElementsByClassName('replTextOutput');
          if (ro.length > 0) text = ro[0].ariaText;
          if (!text) text = elt.innerText;
        }
        return text;
      }



      function speakChar(cm) {
        var pos = cm.getCursor();
        var ln = pos.line; var ch = pos.ch;
        var char = cm.getRange({line: ln, ch: ch}, {line: ln, ch: ch+1});
        if (char === " ") char = "space";
        CPO.sayAndForget(char);
      }


      // end a11y stuff

      container.append(mkWarningUpper());
      container.append(mkWarningLower());

      var promptContainer = jQuery("<div class='prompt-container'>");
      var prompt = jQuery("<span>").addClass("repl-prompt").attr("title", "Enter Pyret code here");
      var promptSign = $('<span aria-hidden="true" aria-label="REPL prompt">').
        addClass('repl-prompt-sign');
      prompt.append(promptSign);
      function showPrompt() {
        promptContainer.hide();
        promptContainer.fadeIn(100);
        CM.setValue("");
        CM.focus();
        CM.refresh();
        scroll(output);
      }
      promptContainer.append(prompt);

      container.on("click", function(e) {
        if($(CM.getTextArea()).parent().offset().top < e.pageY) {
          CM.focus();
        }
      });

      function maybeShowOutputPending() {
        outputPendingHidden = false;
        setTimeout(function() {
          if(!outputPendingHidden) {
            output.append(outputPending);
          }
        }, 200);
      }
      runtime.setStdout(function(str) {
          ct_log(str);
          output.append($("<pre>").addClass("replPrint").text(str));
        });
      var currentZIndex = 15000;
      runtime.setParam("current-animation-port", function(dom, title, closeCallback) {
          var animationDiv = $("<div>").css({"z-index": currentZIndex + 1});
          animationDivs.push(animationDiv);
          output.append(animationDiv);
          function onClose() {
            Jsworld.shutdownSingle({ cleanShutdown: true });
            closeTopAnimationIfOpen();
          }
          closeCallback(closeTopAnimationIfOpen);
          animationDiv.dialog({
            title: title,
            position: ["left", "top"],
            bgiframe : true,
            modal : true,
            overlay : { opacity: 0.5, background: 'black'},
            //buttons : { "Save" : closeDialog },
            width : "auto",
            height : "auto",
            close : onClose,
            closeOnEscape : true
          });
          animationDiv.append(dom);
          var dialogMain = animationDiv.parent();
          dialogMain.css({"z-index": currentZIndex + 1});
          dialogMain.prev().css({"z-index": currentZIndex});
          currentZIndex += 2;
        });

      runtime.setParam("d3-port", function(dom, optionMutator, onExit, buttons) {
          // duplicate the code for now
          var animationDiv = $("<div>");
          animationDivs.push(animationDiv);
          output.append(animationDiv);
          function onClose() {
            onExit();
            closeTopAnimationIfOpen();
          }
          var baseOption = {
            position: [5, 5],
            bgiframe : true,
            modal : true,
            overlay : {opacity: 0.5, background: 'black'},
            width : 'auto',
            height : 'auto',
            close : onClose,
            closeOnEscape : true,
            create: function() {

              // from http://fiddle.jshell.net/JLSrR/116/

              var titlebar = animationDiv.prev();
              buttons.forEach(function(buttonData) {
                var button = $('<button/>'),
                    left = titlebar.find( "[role='button']:last" ).css('left');
                button.button({icons: {primary: buttonData.icon}, text: false})
                       .addClass('ui-dialog-titlebar-close')
                       .css('left', (parseInt(left) + 27) + 'px')
                       .click(buttonData.click)
                       .appendTo(titlebar);
              });
            }
          }
          animationDiv.dialog(optionMutator(baseOption)).dialog("widget").draggable({
            containment: "none",
            scroll: false,
          });
          animationDiv.append(dom);
          var dialogMain = animationDiv.parent();
          dialogMain.css({"z-index": currentZIndex + 1});
          dialogMain.prev().css({"z-index": currentZIndex});
          currentZIndex += 2;
          return animationDiv;
      });
      runtime.setParam("remove-d3-port", function() {
          closeTopAnimationIfOpen();
          // don't call .dialog('close'); because that would trigger onClose and thus onExit.
          // We don't want that to happen.
      });

      runtime.setParam('chart-port', function(args) {
        const animationDiv = $(args.root);
        animationDivs.push(animationDiv);
        output.append(animationDiv);

        let timeoutTrigger = null;

        const windowOptions = {
          title: '',
          position: [5, 5],
          bgiframe: true,
          width: 'auto',
          height: 'auto',
          beforeClose: () => {
            args.draw(options => $.extend({}, options, {chartArea: null}));
            args.onExit();
            closeTopAnimationIfOpen();
          },
          create: () => {
            // from http://fiddle.jshell.net/JLSrR/116/
            const titlebar = animationDiv.prev();
            titlebar.find('.ui-dialog-title').css({'white-space': 'pre'});
            let left = parseInt(titlebar.find("[role='button']:last").css('left'));
            function addButton(icon, fn) {
              left += 27;
              const btn = $('<button/>')
                .button({icons: {primary: icon}, text: false})
                .addClass('ui-dialog-titlebar-close')
                .css('left', left + 'px')
                .click(fn)
                .appendTo(titlebar);
              return btn;
            }

            addButton('ui-icon-disk', () => {
              let savedOptions = null;
              args.draw(options => {
                savedOptions = options;
                return $.extend({}, options, {chartArea: null});
              });
              const download = document.createElement('a');
              download.href = args.getImageURI();
              download.download = 'chart.png';
              // from https://stackoverflow.com/questions/3906142/how-to-save-a-png-from-javascript-variable
              function fireEvent(obj, evt){
                const fireOnThis = obj;
                if(document.createEvent) {
                  const evObj = document.createEvent('MouseEvents');
                  evObj.initEvent(evt, true, false);
                  fireOnThis.dispatchEvent(evObj);
                } else if(document.createEventObject) {
                  const evObj = document.createEventObject();
                  fireOnThis.fireEvent('on' + evt, evObj);
                }
              }
              fireEvent(download, 'click');
              args.draw(_ => savedOptions);
            });
          },
          resize: () => {
            if (timeoutTrigger) clearTimeout(timeoutTrigger);
            timeoutTrigger = setTimeout(args.draw, 100);
          },
        };

        if (args.isInteractive) {
          $.extend(windowOptions, {
            closeOnEscape: true,
            modal: true,
            overlay: {opacity: 0.5, background: 'black'},
            title: '   Interactive Chart',
          });
        } else {
          // need hide to be true so that the dialog will fade out when
          // closing (see https://api.jqueryui.com/dialog/#option-hide)
          // this gives time for the chart to actually render
          $.extend(windowOptions, {hide: true});
        }

        animationDiv
          .dialog($.extend({}, windowOptions, args.windowOptions))
          .dialog('widget')
          .draggable({
            containment: 'none',
            scroll: false,
          });

        // explicit call to draw to correct the dimension after the dialog has been opened
        args.draw();

        const dialogMain = animationDiv.parent();
        if (args.isInteractive) {
          dialogMain.css({'z-index': currentZIndex + 1});
          dialogMain.prev().css({'z-index': currentZIndex});
          currentZIndex += 2;
        } else {
          // a trick to hide the dialog while actually rendering it
          dialogMain.css({
            top: window.innerWidth * 2,
            left: window.innerHeight * 2,
          });
          animationDiv.dialog('close');
        }
      });

      runtime.setParam('remove-chart-port', function() {
          closeTopAnimationIfOpen();
          // don't call .dialog('close'); because that would trigger onClose and thus onExit.
          // We don't want that to happen.
      });

      var breakButton = options.breakButton;
      var stopLi = $('#stopli');
      container.append(output);
      container.append(output).append(promptContainer);

      function speakHistory(n) {
        if(history.size() < n) { return; }
        return speakItem(history.getHistory(n), false);
      }

      function speakItem(item, isMain) {
        if(item === null) { return; }
        //console.log('item=', item);
        var recital = item.code;
        if (item.erroroutput) {
          recital += ' resulted in an error. ' + item.erroroutput;
        } else {
          if (isMain) {
            if (!item.end && !item.start) {
              recital += ' produced no output.';
            } else {
              recital += ' produced output: ';
            }
          } else {
            if (!item.start) {
              recital += ' produced no output.';
            } else {
              recital += ' evaluates to ';
            }
          }
          var docOutput = document.getElementById('output').childNodes;
          if (!item.end) {
            if (item.start) {
              recital += outputText(docOutput[item.start]);
            }
          } else {
            //console.log('speakHistory from', item.start, 'to', item.end);
            for (var i = item.start; i < item.end; i++) {
              recital += '. ' + outputText(docOutput[i]);
            }
          }
        }
        CPO.sayAndForget(recital);
        return true;

      }

      var img = $("<img>").attr({
        "src": "/img/pyret-spin.gif",
        "width": "25px",
      }).css({
        "vertical-align": "middle"
      });
      var runContents;
      function updateItems(isMain) {
        //console.log('doing updateItems', isMain);
        if(!isMain) {
          var thiscode = history.getHistory(1);
        }
        else {
          var thiscode = {code: "definitions", erroroutput: false, start: false, end: false, dup: false};
        }
        var docOutput = document.getElementById("output");
        var docOutputLen = docOutput.childNodes.length;
        var lastOutput = docOutput.lastElementChild;
        //console.log('lastOutput=', lastOutput);
        var text;
        if (lastOutput && lastOutput.classList.contains('compile-error')) {
          //console.log('result is a compile-error');
          thiscode.start = docOutputLen - 1;
          var loChildren = lastOutput.childNodes;
          //console.log('loChildren=', loChildren);
          text = '';
          for (var i = 0; i < loChildren.length; i++) {
            var thisChild = loChildren[i];
            //console.log('thisChild=', thisChild);
            if (thisChild.tagName === 'DIV' && thisChild.classList.contains('cm-snippet')) {
              if (!isMain) {
                //console.log('adding in', thiscode.code);
                text += ' in ' + thiscode.code + '.';
              }
            } else if (thisChild.tagName === 'P') {
              //console.log('adding', thisChild.innerText);
              text += ' ' + thisChild.innerText;
            }
          }
          //console.log('final text=', text);
          thiscode.erroroutput = text;
        } else if (isMain) {
          //console.log('result is a successful load, 0 to', docOutputLen);
          thiscode.start = 0;
          thiscode.end = docOutputLen;
        } else if (lastOutput && lastOutput.classList.contains('echo-container')) {
          thiscode.start = false;
        } else {
          //console.log('result is a successful single interaction');
          thiscode.start = docOutputLen - 1;
        }
        if(isMain) {
          history.storeDefinitions(thiscode);
        }
        speakItem(thiscode, isMain);
        return true;
      }
      function afterRun(cm) {
        return function() {
          //speakHistory(1);
          running = false;
          outputPending.remove();
          outputPendingHidden = true;

          options.runButton.empty();
          options.runButton.append(runContents);
          options.runButton.attr("disabled", false);
          options.runDropdown.attr('disabled', false);
          breakButton.attr("disabled", true);
          stopLi.attr('disabled', true);
          canShowRunningIndicator = false;
          if(cm) {
            cm.setValue("");
            cm.setOption("readonly", false);
          }
          //speakHistory(1);
          //output.get(0).scrollTop = output.get(0).scrollHeight;
          showPrompt();
          setTimeout(function(){
            $(".CodeMirror").each(function(){this.CodeMirror.refresh();});
          }, 200);
        }
      }
      function setWhileRunning() {
        runContents = options.runButton.contents();
        canShowRunningIndicator = true;
        setTimeout(function() {
         if(canShowRunningIndicator) {
            options.runButton.attr("disabled", true);
            options.runDropdown.attr('disabled', true);
            breakButton.attr("disabled", false);
            stopLi.attr('disabled', false);
            options.runButton.empty();
            var text = $("<span>").text("  Running...");
            text.css({
              "vertical-align": "middle"
            });
            options.runButton.append([img, text]);
          }
        }, RUNNING_SPINWHEEL_DELAY_MS);
      }

      // SETUP FOR TRACING ALL OUTPUTS
      var replOutputCount = 0;
      outputUI.installRenderers(repl.runtime);
      repl.runtime.setParam("onTrace", function(loc, val, url) {
        if (repl.runtime.getParam("currentMainURL") !== url) { return { "onTrace": "didn't match" }; }
        if (repl.runtime.isNothing(val)) { return { "onTrace": "was nothing" }; }
        return repl.runtime.pauseStack(function(restarter) {
          repl.runtime.runThunk(function() {
            return repl.runtime.toReprJS(val, repl.runtime.ReprMethods["$cpo"]);
          }, function(container) {
            if (repl.runtime.isSuccessResult(container)) {
              $(output)
                .append($("<div>").addClass("trace")
                        .append($("<span>").addClass("trace").text("Trace #" + (++replOutputCount)))
                        .append(container.result));
              scroll(output);
            } else {
              $(output).append($("<div>").addClass("error trace")
                               .append($("<span>").addClass("trace").text("Trace #" + (++replOutputCount)))
                               .append($("<span>").text("<error displaying value: details logged to console>")));
              console.log(container.exn);
              scroll(output);
            }
            restarter.resume(val);
          });
        });
      });

      /**
         Richly displays the output in the interactions area
         @param {!PBase} val

         @return {!PBase} the value given in
       */
      repl.runtime.setParam("displayRenderer", function(val) {
        return repl.runtime.pauseStack(function(restarter) {
          repl.runtime.runThunk(function() {
            return repl.runtime.toReprJS(val, repl.runtime.ReprMethods["$cpo"]);
          }, function(container) {
            if (repl.runtime.isSuccessResult(container)) {
              $(output).append($("<div>").append(container.result));
              scroll(output);
            } else {
              $(output).append($("<div>").addClass("error")
                               .append($("<span>").text("<error displaying value: details logged to console>")));
              console.log(container.exn);
              scroll(output);
            }
            restarter.resume(val);
          });
        });
      });

      /**
         Directly outputs the given Pyret value to the console
         @param {!PBase} val

         @return {!PBase} the value given in
       */
      repl.runtime.setParam("errorDisplayRenderer", function(val) {
        console.log("display-error: ", val);
        return val;
      });
      `unquote to restore spying
      repl.runtime.setParam("onSpy", function(loc, message, locs, names, vals) {
        return repl.runtime.safeCall(function() {
          /*
          var toBeRepred = [];
          for (var i = 0; i < names.length; i++)
            toBeRepred.push({name: names[i], val: vals[i]});
          toBeRepred.push({name: "Message", val: message, method: repl.runtime.ReprMethods._tostring});
          */
          // Push this afterward, to keep rendered aligned with renderedLocs below
          return repl.runtime.safeCall(function() {
            return repl.runtime.toReprJS(message, repl.runtime.ReprMethods._tostring);
          }, function(message) {
            return repl.runtime.safeCall(function() {
              return repl.runtime.raw_array_map(repl.runtime.makeFunction(function(val) {
                 return repl.runtime.toReprJS(val, repl.runtime.ReprMethods["$cpo"]);
              }, "spy-to-repr"), vals);
            }, function(rendered) {
              return {
                message: message,
                rendered: rendered
              }
            }, "CPO-onSpy-render-values");
          }, "CPO-onSpy-render-message");
        }, function(spyInfo) {
          var message = spyInfo.message;
          var rendered = spyInfo.rendered
          // Note: renderedLocs is one element shorter than rendered
          var renderedLocs = locs.map(repl.runtime.makeSrcloc);
          var spyBlock = $("<div>").addClass("spy-block");
          spyBlock.append($("<img>").addClass("spyglass").attr("src", "/img/spyglass.gif"));
          if (message !== "") {
            spyBlock.append($("<div>").addClass("spy-title").append(message));
          }

          var table = $("<table>");
          table
            .append($("<th>")
                    .append($("<tr>")
                            .append($("<td>").text("Name"))
                            .append($("<td>").text("Value"))));
          spyBlock.append(table);
          var palette = outputUI.makePalette();
          function color(i) {
            return outputUI.hueToRGB(palette(i));
          }
          for (let i = 0; i < names.length; i++) {
            let row = $("<tr>");
            table.append(row);
            let name = $("<a>").text(names[i]).addClass("highlight");
            name.attr("title", "Click to scroll source location into view");
            if (locs[i].length === 7) {
              try {
                var pos = outputUI.Position.fromSrcArray(locs[i], CPO.documents, {});
                name.hover((function(pos) {
                  return function() {
                    pos.hint();
                    pos.blink(color(i));
                  }
                })(pos),
                (function(pos) {
                  return function() {
                    outputUI.unhintLoc();
                    pos.blink(undefined);
                  };
                })(pos));
                name.on("click", (function(pos) {
                  return function() { pos.goto(); };
                })(pos));
              } catch (e) {
                name.attr("title", "From " + runtime.getField(runtime.makeSrcloc(locs[i]), "format").app(true));
              }
              // TODO: this is ugly code, copied from output-ui because
              // getting the right srcloc library is hard
              let cmLoc = {
                source: locs[i][0],
                start: {line: locs[i][1] - 1, ch: locs[i][3]},
                end: {line: locs[i][4] - 1, ch: locs[i][6]}
              };
              /*
              name.on("click", function() {
                outputUI.emphasizeLine(CPO.documents, cmLoc);
                CPO.documents[cmLoc.source].scrollIntoView(cmLoc.start, 100);
              });
              */
            }
            row.append($("<td>").append(name).append(":"));
            row.append($("<td>").append(rendered[i]));
          }
          $(output).append(spyBlock);
          return repl.runtime.nothing;
        }, "CPO-onSpy");
      });`

      var runMainCode = function(src, uiOptions) {
        if(running) { return; }
        history.setToEnd();
        running = true;
        output.empty();
        promptContainer.hide();
        lastEditorRun = uiOptions.cm || null;
        setWhileRunning();

        CPO.documents.forEach(function(doc, name) {
          if (name.indexOf("interactions://") === 0)
            CPO.documents.delete(name);
        });

        interactionsCount = 0;
        replOutputCount = 0;
        logger.log('run', { name      : "definitions://",
                            type_check: !!document.getElementById("option-tc").checked,
                          });
        var options = {
          typeCheck: !!document.getElementById("option-tc").checked,
          checkMode: !!!document.getElementById("option-check-mode").checked,
          checkAll: false // NOTE(joe): this is a good spot to fetch something from the ui options
                          // if this becomes a check box somewhere in CPO
        };

        cloud_log("RUN_START", {
          submission:
            [...new Set(sourceAPI.unique_loaded.filter(s => !s.ephemeral && !s.shared))]
              .map(s => new Object({
                name: s.name,
                id: s.file.getUniqueId(),
                role
                  : s.name.includes("code") ? "code"
                  : s.name.includes("tests") ? "tests"
                  : s.name.includes("common") ? "common"
                  : null,
                contents: s.contents,
              }))
        });

        function run_injections(injections) {
          let first = injections[0];
          let rest = injections.slice(1);
          if (first !== undefined) {
            window.injection = first;
            options.checkAll = false;
            options.checkMode = true;
            runtime.setStdout(function() {});
            return repl.restartInteractions(src, options)
              .then(jsonResult(output, runtime, repl.runtime, true))
              .then(
                function(result) {
                  let name = window.injection.getName();
                  return run_injections(rest)
                    .then(function(rest_results) {
                      rest_results.push({name: name, result: result});
                      return rest_results;
                    });
                });
          } else {
            return Q([]);
          }
        }

        let send_log = Q.defer();
        let payload = {
          sources:
            [...new Set(sourceAPI.unique_loaded.filter(s => !s.ephemeral && !s.shared))]
              .map(s => new Object({
                name: s.name,
                id: s.file.getUniqueId(),
                role
                  : s.name.includes("code") ? "code"
                  : s.name.includes("tests") ? "tests"
                  : s.name.includes("common") ? "common"
                  : null,
                contents: s.contents,
              }))
        };

        send_log.promise.then(function(){
          cloud_log("RUN_END", payload);
        });

        if (!document.getElementById("option-check-mode").checked) {
          // TODO fix repl behavior when wheat fails.
          // repl should happen in context of impl file if wheat fails
          // TODO improve wheat failure error message behavior
          // e.g.,: print(raise(median([list:1])))

          // first, run the wheat
          let wheat_results = window.wheat.then(run_injections)
            .then(results => {
              payload.wheat_results = results.map(result =>
                new Object({
                  name: result.name,
                  result: result.result.json,
                })
              );

              // strip the names
              return results.map(result => result.result);
            }) ;

          let wheats_pass = wheat_results.then(
            function(check_results) {
              let wheats = check_results.length;
              let passed =
                check_results.map(r => r.json).filter(
                  wheat => wheat.every(
                    block => !block.error
                      && block.tests.every(test => test.passed))).length;
              let all_passed = wheats == passed;
              if (all_passed) {
                payload.wheat_passed = true;
                return check_results;
              } else {
                payload.wheat_passed = false;
                throw check_results;
              }
            });

          // if the wheats pass, then run the chaffs
          let chaff_results = wheats_pass
            .then(
              function(_){
                let run_results = window.chaff.then(run_injections);
                run_results.then(results =>
                  payload.chaff_results = results.map(result =>
                      new Object({
                        name: result.name,
                        result: result.result.json,
                      })
                    ));
                // strip the names
                return run_results.then(results => results.map(result => result.result));
              }, function(wheat_reject) {
                if (wheat_reject instanceof Array) {
                  // don't halt the execution pipeline if the if the wheats
                  // failed in a well-behaved way (e.g., failing test case)
                  return null;
                } else {
                  // otherwise, don't try to recover
                  throw wheat_reject;
                }
              });

          // lastly, run the student's tests, if they've begun their implementation.
          let test_results = Q.all([window.dummy_impl, chaff_results]).then(
            function([dummy_impl, _]){
              let impl_exists = sourceAPI.loaded.some(function(f) {
                if (f.file && f.file.getName) {
                  return f.file.getName().includes("code");
                } else {
                  return false;
                }
              });

              runtime.setStdout(function(str){
                output.append($("<pre>").addClass("replPrint").text(str));
              });

              if (impl_exists) {
                console.log("test_results");
                delete window.injection;
                // run students' impl tests, too
                options.checkAll = true;
                options.checkMode = true;
                return repl.restartInteractions(src, options);
              } else {
                // run the dummy impl
                window.injection = dummy_impl;
                options.checkMode = false;
                return repl.restartInteractions(src, options);
              }
            }, function(e) {
              console.error("CHAFF ERROR?", e);
              return null;
            }).then(jsonResult(output, runtime, repl.runtime, true));

          test_results.then(local_result => {
            payload.local_result = local_result.json;
          })
          .then(
            function(_) {send_log.resolve()},
            function(e) {send_log.resolve()});

          // then display the result
          let display_result =
            Q.all([wheat_results, chaff_results, test_results]).then(
              function([wheat_results, chaff_results, test_results]) {
                let wheat_block_error = wheat_results.find(w => w.json.some(b => b.error));
                if (wheat_block_error) {
                  return displayResult(output, runtime, repl.runtime, true, updateItems)(
                                        wheat_block_error.pyret,
                                       {error: true, wheat: wheat_results.map(r => r.json)});
                }
                if (chaff_results) {
                  chaff_results = chaff_results.map(r => r.json)
                }
                return displayResult(output, runtime, repl.runtime, true, updateItems)(test_results.pyret,
                                     {wheat: wheat_results.map(r => r.json), chaff: chaff_results});
              }, function(error_result) {
                payload.error = true;
                send_log.resolve();
                return displayResult(output, runtime, repl.runtime, true, updateItems)(error_result,
                  {error: true});
              });

          display_result.fin(afterRun(false));
        } else {
            maybeShowOutputPending();
            payload.skip_checks = true;
            repl.restartInteractions(src, options)
              .then(function(run_result) {
                send_log.resolve();
                return displayResult(output, runtime, repl.runtime, true, updateItems)(run_result);
              }, function(error_result) {
                send_log.resolve();
                return displayResult(output, runtime, repl.runtime, true, updateItems)(error_result);
              })
              .fin(afterRun(false));
        }
      };

      var runner = function(code) {
        if(running) { return; }
        running = true;
        var thiscode = {code: code, erroroutput: false, start: false, end: false, dup: false};
        history.addToHistory(thiscode);
        history.setToEnd();
        var echoContainer = $("<div class='echo-container'>");
        var echoSpan = $("<span>").addClass("repl-echo");
        var echoPromptSign = $('<span aria-hidden="true" aria-label="REPL prompt">').
          addClass('repl-prompt-sign');
        echoSpan.append(echoPromptSign);
        var echo = $("<textarea>");
        echoSpan.append(echo);
        echoContainer.append(echoSpan);
        write(echoContainer);
        var echoCM = CodeMirror.fromTextArea(echo[0], { readOnly: true });
        echoCM.setValue(code);
        CM.setValue("");
        promptContainer.hide();
        setWhileRunning();
        interactionsCount++;
        var thisName = 'interactions://' + interactionsCount;
        let source = sourceAPI.from_doc(thisName, echoCM.getDoc());
        logger.log('run', { name: thisName });
        cloud_log("REPL_START", {code: code});
        var replResult = repl.run(code, thisName);
//        replResult.then(afterRun(CM));
        var startRendering = replResult.then(function(r) {
          maybeShowOutputPending();
          return r;
        });
        var doneRendering = startRendering.then(displayResult(output, runtime, repl.runtime, false, updateItems)).fail(function(err) {
          console.error("Error displaying result: ", err);
        });
        doneRendering.fin(afterRun(CM));
      };

      var CM = CPO.makeEditor(prompt, {
        simpleEditor: true,
        run: runner,
        initial: "",
        cmOptions: {
          scrollPastEnd: false,
          extraKeys: CodeMirror.normalizeKeyMap({
            'Enter': function(cm) { runner(cm.getValue(), {cm: cm}); },
            'Shift-Enter': "newlineAndIndent",
            'Tab': 'indentAuto',
            'Up': function(){ return history.prevItem(); },
            'Down': function(){ return history.nextItem(); },
            'Ctrl-Up': "goLineUp",
            'Ctrl-Alt-Up': "goLineUp",
            'Ctrl-Down': "goLineDown",
            'Ctrl-Alt-Down': "goLineDown",
            'Esc Left': "goBackwardSexp",
            'Alt-Left': "goBackwardSexp",
            'Esc Right': "goForwardSexp",
            'Alt-Right': "goForwardSexp",
            'Ctrl-Left': "goBackwardToken",
            'Ctrl-Right': "goForwardToken",
            'Left': function(cm) { cm.moveH(-1, 'char'); speakChar(cm); },
            'Right': function(cm) { cm.moveH(1, 'char'); speakChar(cm); },
            "Alt-1": function() { speakHistory(1, false); },
            "Alt-2": function() { speakHistory(2, false); },
            "Alt-3": function() { speakHistory(3, false); },
            "Alt-4": function() { speakHistory(4, false); },
            "Alt-5": function() { speakHistory(5, false); },
            "Alt-6": function() { speakHistory(6, false); },
            "Alt-7": function() { speakHistory(7, false); },
            "Alt-8": function() { speakHistory(8, false); },
            "Alt-9": function() { speakHistory(9, false); },
            "Alt-0": function() { speakItem(history.getDefinitions(), true); },
          })
        }
      }).cm;

      var history = replHistory.makeReplHistory(CM, CPO);

      CM.on('beforeChange', function(instance, changeObj){textHandlers.autoCorrect(instance, changeObj, CM);});

      var lastNameRun = 'interactions';
      var lastEditorRun = null;

      var write = function(dom) {
        output.append(dom);
      };

      var onBreak = function() {
        breakButton.attr("disabled", true);
        stopLi.attr('disabled', true);
        repl.stop();
        closeAnimationIfOpen();
        Jsworld.shutdown({ cleanShutdown: true });
        showPrompt();
      };

      breakButton.attr("disabled", true);
      stopLi.attr('disabled', true);
      breakButton.click(onBreak);

      return {
        cm: CM,
        refresh: function() { CM.refresh(); },
        runCode: runMainCode,
        focus: function() { CM.focus(); }
      };
    }

    // Declared here to use CM, used and closed over many times above

    return runtime.makeJSModuleReturn({
      makeRepl: makeRepl,
      makeEditor: CPO.makeEditor
    });

  }
})
