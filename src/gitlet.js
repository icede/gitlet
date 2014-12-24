var fs = require("fs");
var files = require("./files");
var index = require("./index");
var objects = require("./objects");
var refs = require("./refs");
var diff = require("./diff");
var workingCopy = require("./working-copy");
var util = require("./util");
var parseOptions = require("./parse-options");
var config = require("./config");
var merge = require("./merge");
var commit = require("./commit");
var fetch = require("./fetch");

var gitlet = module.exports = {
  init: function(opts) {
    if (files.inRepo()) { return; }
    opts = opts || {};

    var conf = config.objToStr({ core: { "": { bare: (opts.bare === true).toString() }}});
    var gitletStructure = {
      HEAD: "ref: refs/heads/master\n",
      config: conf,
      objects: {},
      refs: {
        heads: {},
      }
    };

    files.writeFilesFromTree(opts.bare ? gitletStructure : { ".gitlet": gitletStructure },
                             process.cwd());
  },

  add: function(path, _) {
    files.assertInRepo();
    config.assertNotBare();

    var addedFiles = files.lsRecursive(path);
    if (addedFiles.length === 0) {
      throw "fatal: pathspec " + files.pathFromRepoRoot(path) + " did not match any files";
    } else {
      for (var i = 0; i < addedFiles.length; i++) {
        this.update_index(addedFiles[i], { add: true });
      }
    }
  },

  rm: function(path, opts) {
    files.assertInRepo();
    config.assertNotBare();
    opts = opts || {};

    var diskFiles = files.lsRecursive(path);
    var fileList = Object.keys(index.readToc()).
        filter(function(p) { return p === path || diskFiles.indexOf(p) !== -1; });
    if (opts.f) {
      throw "unsupported";
    } else if (fileList.length === 0) {
      throw "fatal: pathspec " + files.pathFromRepoRoot(path) + " did not match any files";
    } else if (fs.existsSync(path) && fs.statSync(path).isDirectory() && !opts.r) {
      throw "fatal: not removing " + path + " recursively without -r";
    } else {
      var headToc = refs.readHash("HEAD") ? objects.readCommitToc(refs.readHash("HEAD")) : {}
      var wcDiff = diff.nameStatus(headToc, index.readWorkingCopyToc());
      var addedModified = Object.keys(wcDiff)
          .filter(function(p) { return wcDiff[p] !== diff.FILE_STATUS.DELETE; });
      var changesToRm = util.intersection(addedModified, fileList);

      if (changesToRm.length > 0) {
        throw "error: the following files have changes:\n" + changesToRm.join("\n") + "\n";
      } else {
        for (var i = 0; i < fileList.length; i++) {
          if (fs.existsSync(fileList[i])) {
            fs.unlinkSync(fileList[i]);
          }

          this.update_index(fileList[i], { remove: true });
        }
      }
    }
  },

  commit: function(opts) {
    files.assertInRepo();
    config.assertNotBare();

    var headHash = refs.readHash("HEAD");
    var treeHash = this.write_tree();
    var headDesc = refs.readIsHeadDetached() ? "detached HEAD" : refs.readCurrentBranchName();

    if (headHash !== undefined &&
        treeHash === objects.treeHash(objects.read(headHash))) {
      throw "# On " + headDesc + "\n" + "nothing to commit, working directory clean";
    } else {
      var message = merge.readIsMergeInProgress() ?
          files.read(files.gitletPath("MERGE_MSG")) :
          opts.m;
      var commmitHash = objects.write(objects.composeCommit(treeHash,
                                                            message,
                                                            commit.readParentHashes()));
      this.update_ref("HEAD", commmitHash);
      if (merge.readIsMergeInProgress()) {
        var conflictedPaths = index.readConflictedPaths();
        if (conflictedPaths.length > 0) {
          throw conflictedPaths.map(function(p) { return "U " + p; }).join("\n") + "\n" +
            "error: 'commit' is not possible because you have unmerged files.\n";
        } else {
          fs.unlinkSync(files.gitletPath("MERGE_MSG"));
          refs.rm("MERGE_HEAD");
          return "Merge made by the three-way strategy.";
        }
      } else {
        return "[" + headDesc + " " + commmitHash + "] " + message;
      }
    }
  },

  branch: function(name, opts) {
    files.assertInRepo();
    opts = opts || {};

    if (name === undefined && opts.u === undefined) {
      return Object.keys(refs.readLocalHeads()).map(function(branch) {
        return (branch === refs.readCurrentBranchName() ? "* " : "  ") + branch;
      }).join("\n") + "\n";
    } else if (refs.readHash("HEAD") === undefined) {
      throw "fatal: Not a valid object name: master.";
    } else if (name === undefined && opts.u !== undefined) {
      var rem = opts.u.split("/");

      if (refs.readIsHeadDetached()) {
        throw "fatal: could not set upstream of HEAD to " + opts.u +
          " when it does not point to any branch.";
      } else if (!refs.readExists(refs.toRemoteRef(rem[0], rem[1]))) {
        throw "error: the requested upstream branch " + opts.u + " does not exist";
      } else {
        config.write(util.assocIn(config.read(), ["branch", rem[1], "remote", rem[0]]));
        return "Branch " + refs.readCurrentBranchName() +
          " set up to track remote branch " + rem[1] + " from " + rem[0] + ".";
      }
    } else if (refs.readExists(refs.toLocalRef(name))) {
      throw "fatal: A branch named " + name + " already exists.";
    } else {
      this.update_ref(refs.toLocalRef(name), refs.readHash("HEAD"));
    }
  },

  checkout: function(ref, _) {
    files.assertInRepo();
    config.assertNotBare();

    var toHash = refs.readHash(ref);
    if (!objects.readExists(toHash)) {
      throw "error: pathspec " + ref + " did not match any file(s) known to gitlet."
    } else if (objects.type(objects.read(toHash)) !== "commit") {
      throw "fatal: reference is not a tree: " + ref;
    } else if (ref === refs.readCurrentBranchName() ||
               ref === files.read(files.gitletPath("HEAD"))) {
      return "Already on " + ref;
    } else {
      var paths = diff.readChangedFilesCommitWouldOverwrite(toHash);
      if (paths.length > 0) {
        throw "error: Aborting. Your local changes to these files would be overwritten:\n" +
	        paths.join("\n") + "\n";
      } else {
        process.chdir(files.workingCopyPath());

        var fromHash = refs.readHash("HEAD");
        var isDetachingHead = objects.readExists(ref);
        workingCopy.write(diff.diff(objects.readCommitToc(fromHash),
                                    objects.readCommitToc(toHash)));
        refs.write("HEAD", isDetachingHead ? toHash : "ref: " + refs.toLocalRef(ref));
        index.write(index.tocToIndex(objects.readCommitToc(toHash)));
        return isDetachingHead ?
          "Note: checking out " + toHash + "\nYou are in detached HEAD state." :
          "Switched to branch " + ref;
      }
    }
  },

  diff: function(ref1, ref2, opts) {
    files.assertInRepo();
    config.assertNotBare();

    if (ref1 !== undefined && refs.readHash(ref1) === undefined) {
      throw "fatal: ambiguous argument " + ref1 + ": unknown revision";
    } else if (ref2 !== undefined && refs.readHash(ref2) === undefined) {
      throw "fatal: ambiguous argument " + ref2 + ": unknown revision";
    } else {
      if (opts["name-status"] !== true) {
        throw "unsupported"; // for now
      } else {
        var nameToStatus = diff.readDiff(refs.readHash(ref1),
                                         refs.readHash(ref2));
        return Object.keys(nameToStatus)
          .map(function(path) { return nameToStatus[path] + " " + path; })
          .join("\n") + "\n";
      }
    }
  },

  remote: function(command, name, path, _) {
    files.assertInRepo();

    if (command !== "add") {
      throw "unsupported";
    } else if (name in config.read()["remote"]) {
      throw "fatal: remote " + name + " already exists.";
    } else if (command === "add") {
      config.write(util.assocIn(config.read(), ["remote", name, "url", path]));
      return "\n";
    }
  },

  fetch: function(remote, _) {
    files.assertInRepo();

    if (remote === undefined) {
      throw "unsupported";
    } else if (!(remote in config.read().remote)) {
      throw "fatal: " + remote + " does not appear to be a git repository";
    } else {
      var originalDir = process.cwd();
      var localUrl = files.gitletPath();
      var remoteUrl = config.read().remote[remote].url;

      process.chdir(remoteUrl);
      var giverRemoteRefs = refs.readLocalHeads();
      var remoteObjects = objects.readAllHashes().map(objects.read);

      process.chdir(localUrl);
      remoteObjects.forEach(objects.write);
      var receiverRemoteRefs = refs.readRemoteHeads(remote);
      var changedRefs = Object.keys(giverRemoteRefs)
          .filter(function(b) { return giverRemoteRefs[b] !== receiverRemoteRefs[b]; });

      refs.write("FETCH_HEAD", refs.composeFetchHead(giverRemoteRefs, remoteUrl));
      changedRefs.forEach(function(b) {
        gitlet.update_ref(refs.toRemoteRef(remote, b), giverRemoteRefs[b])
      });

      process.chdir(originalDir);

      var refUpdateReport = changedRefs.map(function(b) {
        return b + " -> " + remote + "/" + b +
          (fetch.readIsForced(receiverRemoteRefs[b], giverRemoteRefs[b]) ? "" : "forced");
      });

      return ["From " + remoteUrl,
              "Count " + remoteObjects.length]
        .concat(refUpdateReport)
        .join("\n") + "\n";
    }
  },

  merge: function(ref, _) {
    files.assertInRepo();
    config.assertNotBare();

    var giverHash = refs.readHash(ref);
    if (refs.readIsHeadDetached()) {
      throw "unsupported";
    } else if (giverHash === undefined || objects.type(objects.read(giverHash)) !== "commit") {
      throw "error: " + ref + ": expected commit type";
    } else {
      var receiverHash = refs.readHash("HEAD");
      if (receiverHash === giverHash || objects.readIsAncestor(receiverHash, giverHash)) {
        return "Already up-to-date.";
      } else {
        var paths = diff.readChangedFilesCommitWouldOverwrite(giverHash);
        if (paths.length > 0) {
          throw "Aborting. Local changes would be overwritten:\n" + paths.join("\n") + "\n";
        } else if (merge.readCanFastForward(receiverHash, giverHash)) {
          merge.writeFastForwardMerge(receiverHash, giverHash);
          return "Fast-forward";
        } else {
          merge.writeNonFastForwardMerge(receiverHash, giverHash, ref);
          if (merge.readHasConflicts(receiverHash, giverHash)) {
            return "Automatic merge failed. Fix conflicts and commit the result.";
          } else {
            return this.commit();
          }
        }
      }
    }
  },

  pull: function(remote, _) {
    files.assertInRepo();
    config.assertNotBare();
    this.fetch(remote);
    return this.merge("FETCH_HEAD");
  },

  push: function() {
    files.assertInRepo();
  },

  update_index: function(path, opts) {
    files.assertInRepo();
    config.assertNotBare();
    opts = opts || {};

    var pathFromRoot = files.pathFromRepoRoot(path);
    var isOnDisk = fs.existsSync(path);
    var isInIndex = index.readHasFile(path, 0);

    if (isOnDisk && fs.statSync(path).isDirectory()) {
      throw "error: " + pathFromRoot + ": is a directory - add files inside instead\n";
    } else if (opts.remove && !isOnDisk && isInIndex) {
      if (index.readFileInConflict(path)) {
        throw "unsupported";
      } else {
        index.writeRm(path);
        return "\n";
      }
    } else if (opts.remove && !isOnDisk && !isInIndex) {
      return "\n";
    } else if (!opts.add && isOnDisk && !isInIndex) {
      throw "error: "+ pathFromRoot +": cannot add to the index - missing --add option?\n";
    } else if (isOnDisk && (opts.add || isInIndex)) {
      index.writeAdd(path);
      return "\n";
    } else if (!opts.remove && !isOnDisk) {
      throw "error: " + pathFromRoot + ": does not exist and --remove not passed\n";
    }
  },

  write_tree: function(_) {
    files.assertInRepo();
    return objects.writeTree(files.nestFlatTree(index.readToc()));
  },

  update_ref: function(refToUpdate, refToUpdateTo, _) {
    files.assertInRepo();

    var hash = refs.readHash(refToUpdateTo);
    if (!objects.readExists(hash)) {
      throw "fatal: " + refToUpdateTo + ": not a valid SHA1";
    } else if (!refs.isRef(refToUpdate)) {
      throw "fatal: Cannot lock the ref " + refToUpdate + ".";
    } else if (objects.type(objects.read(hash)) !== "commit") {
      throw "error: Trying to write non-commit object " + hash + " to branch " +
        refs.readTerminalRef(refToUpdate) + "\n";
    } else {
      refs.write(refs.readTerminalRef(refToUpdate), hash);
    }
  }
};

var runCli = module.exports.runCli = function (argv) {
  var rawArgs = parseOptions(argv);
  var commandFnName = rawArgs._[2].replace(/-/g, "_");
  var fn = gitlet[commandFnName];
  var commandArgs = rawArgs._.slice(3);
  var unspecifiedArgs = Array
      .apply(null, new Array(fn.length - commandArgs.length - 1))
      .map(function() { return undefined; });

  try {
    return fn.apply(gitlet, commandArgs.concat(unspecifiedArgs).concat(rawArgs));
  } catch (e) {
    console.log(e)
  }
};

if (require.main === module) {
  var result = runCli(process.argv);
  if (result !== undefined) {
    console.log(result);
  }
}
