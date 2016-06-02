/*jslint node:true, esversion:6 */

var fs = require('fs'), Packet = require('packet-api'), async = require('async'), _ = require('lodash'), 
scp = require('scp2'),
ssh = require('simple-ssh'), keypair = require('keypair'), forge = require('node-forge'), jsonfile = require('jsonfile'),
argv = require('minimist')(process.argv.slice(2));

// import the token from the file token
const TOKEN = fs.readFileSync('token').toString().replace(/\n/,''), pkt = new Packet(TOKEN),
SSHFILE = './keys',
PROJDATE = new Date().toISOString(),
projName = "ULL-network-performance-test-"+PROJDATE,
SIZES = [300,500,1024,2048],
PROTOCOLS = ['TCP','UDP'],
TESTS = ["metal","bridge","host"],
NETWORKS = ["local","remote"],
CHECKDELAY = 30,
NETSERVERPORT = 7002,
NETSERVERDATAPORT = 7003,
NETSERVERLOCALPORT = 7004,
REPETITIONS = 50000,

log = function (msg) {
	let m = typeof(msg) === 'object' ? JSON.stringify(msg) : msg;
	console.log(new Date().toISOString()+": "+m);
},
devices = {
	source1: {
		type: 1,
		purpose: "source"
	},
	source3: {
		type: 3,
		purpose: "source"
	},
	target1: {
		type: 1,
		purpose: "target"
	},
	target3: {
		type: 3,
		purpose: "target"
	}
};

const genTestList = function (params) {
	let tests = [];
	_.each(params.protocols,function (proto) {
		_.each(params.sizes, function (size) {
			_.each(params.networks, function (nettest) {
				_.each(_.keys(_.pickBy(params.devices,{purpose:"target"})),function (dev) {
					let from = nettest === "local" ? dev : dev.replace('target','source');
					tests.push({test: params.test, type: nettest, from:from, to:dev, port:params.port, reps: params.reps, size: size, protocol: proto});
				});
			});
		});
	});
	return tests;
},

startReflectors = function (targets,startCmd,ipCmd,callback) {
	if (callback === undefined && typeof(ipCmd) === "function") {
		callback = ipCmd;
		ipCmd = null;
	}
	let targetIds = {};
	// now start the reflector on each
	async.each(targets,function (target,cb) {
		let errCode = false;
		targetIds[target] = {};
		var session = new ssh({
			host: devices[target].ip_public.address,
			user: "root",
			key: pair.private
		});
		// start the netserver container
		session.exec(startCmd,{
			exit: function (code,stdout) {
				if (code !== 0) {
					errCode = true;
					session.end();
					cb(target+": Failed to start netserver");
				} else {
					targetIds[target].id = stdout.replace(/\n/,'').replace(/\s+/,'');
				}
				// do we have an IP command?
				if (ipCmd) {
					session.exec(ipCmd,{
						exit: function (code,stdout) {
							if (code !== 0) {
								errCode = true;
								session.end();
								cb(target+": Failed to get netserver IP");
							} else {
								// if it has no IP, go for localhost
								let ip = stdout.replace(/\n/,'').replace(/\s+/,'');
								targetIds[target].ip = ip && ip !== "" ? ip : 'localhost';
							}
						}
					});
				} else {
					targetIds[target].ip = devices[target].ip_private.address;
				}
			}
		});
		session.on('error',function (err) {
			log(target+": ssh error connecting to start netserver");
			log(err);
			session.end();
			cb(target+": ssh connection failed");
		});
		session.on('close',function (hadError) {
			if (!hadError && !errCode) {
				log(target+": netserver started "+targetIds[target].id);
				cb(null);
			}
		});
		session.start();
	},function (err) {
		if(err) {
			callback(err);
		} else {
			callback(null,targetIds);
		}
	});
},
runTests = function (tests,targets,msgPrefix,cmdPrefix,callback) {
	// this must be run in series so they don't impact each other
	if (callback === undefined && typeof(cmdPrefix) === "function") {
		callback = cmdPrefix;
		cmdPrefix = "";
	}
	async.mapSeries(tests,function (t,cb) {
		let msg = msgPrefix+" test: "+t.type+" "+t.protocol+" "+t.size, output,
		target = t.type === "remote" ? devices[t.to].ip_private.address : targets[t.to].ip,
		errCode = false;
		log(t.from+": running "+msg);
		// get the private IP for the device
		let session = new ssh({
			host: devices[t.from].ip_public.address,
			user: "root",
			key: pair.private
		}), cmd = cmdPrefix+'netperf  -P 0 -H '+target+' -c -t '+t.protocol+'_RR -l -'+t.reps+' -v 2 -p '+t.port+' -- -k -r '+t.size+','+t.size+' -P '+NETSERVERLOCALPORT+','+NETSERVERDATAPORT;
		//log(dockerCmd);
		session.exec(cmd, {
			exit: function (code,stdout) {
				if (code !== 0) {
					errCode = true;
					session.end();
					cb(t.from+": Failed to start netperf");
				} else {
					output = stdout;
				}
			}
		})
		;
		session.on('error',function (err) {
			log(t.from+": ssh error connecting for "+msg);
			log(err);
			session.end();
			cb(t.from+": ssh connection failed");
		});
		session.on('close',function (hadError) {
			if (!hadError && !errCode) {
				log(t.from+": test complete: "+msg);
				// save the results from this test
				cb(null,_.extend({},t,{results:output}));
			}
		});
		session.start();
	},callback);
},

stopReflectors = function (targets,cmd,callback) {
	// stop the netserver reflectors
	async.each(_.keys(targets),function (target,cb) {
		let errCode = false;
		var session = new ssh({
			host: devices[target].ip_public.address,
			user: "root",
			key: pair.private
		});
		// stop the netserver container
		session.exec(cmd,{
			exit: function (code) {
				if (code !== 0) {
					errCode = true;
					session.end();
					cb(target+": Failed to stop netserver "+targets[target].id);
				}
			}
		});
		session.on('error',function (err) {
			log(target+": ssh error connecting to stop netserver");
			log(err);
			session.end();
			cb(target+": ssh connection failed");
		});
		session.on('close',function (hadError) {
			if (!hadError && !errCode) {
				log(target+": netserver stopped "+targets[target].id);
				cb(null);
			}
		});
		session.start();
	},callback);
},

runHostTests = function (tests,callback) {
	// find all of the targets
	let targets = _.uniq(_.map(tests,"to")), targetIds = {}, allResults;
	
	// three steps:
	// 1- start reflectors
	// 2- run tests
	// 3- stop reflectors
	async.waterfall([
		function (cb) {
			startReflectors(targets,'netserver -p '+NETSERVERPORT+' >/dev/null && pgrep netserver',cb);
		},
		function (res,cb) {
			targetIds = res;
			runTests(tests,targetIds,"benchmark",cb);
		},
		function (res,cb) {
			allResults = res;
			stopReflectors(targetIds,"pkill netserver",cb);
		}
	],function (err) {
		callback(err,allResults);
	});
},

runContainerTests = function (tests,nettype,callback) {
	// need to start the reflector container on each target
	
	// find all of the targets
	let targets = _.uniq(_.map(tests,"to")), targetIds = {}, netarg = nettype ? '--net='+nettype : '', allResults;
	
	// three steps:
	// 1- start reflectors
	// 2- run tests
	// 3- stop reflectors
	
	async.waterfall([
		function (cb) {
			let portline = '-p '+NETSERVERPORT+':'+NETSERVERPORT+' -p '+NETSERVERDATAPORT+':'+NETSERVERDATAPORT+' -p '+NETSERVERDATAPORT+':'+NETSERVERDATAPORT+'/udp',
			startCmd = 'docker run '+portline+' '+netarg+' -d --name=netserver netperf netserver -D -p '+NETSERVERPORT,
			ipCmd = "docker inspect --format '{{ .NetworkSettings.IPAddress }}' netserver";
			startReflectors(targets,startCmd,ipCmd,cb);
		},
		function (res,cb) {
			targetIds = res;
			runTests(tests,targetIds,"container","docker run --rm "+netarg+" netperf ",cb);
		},
		function (res,cb) {
			allResults = res;
			stopReflectors(targetIds,"docker stop netserver && docker rm netserver",cb);
		}
	],function (err) {
		callback(err,allResults);
	});
}

;

// use command line args to determine
// - if to install software
// - if to run tests
// - if to destroy project
// default:
//		software: install
//		tests: run
var projId = argv.project || null,
activeTypes = _.uniq([].concat(argv.type || [])),
activeDevs = _.reduce(devices,function (active,value,item) {
	if (activeTypes.length === 0 || _.indexOf(activeTypes,value.type) > -1) {
		active[item] = value;
	}
	return active;
},{}),
pair,
keepItems = argv.keep || false,
activeProtocols = _.uniq([].concat(argv.protocol || PROTOCOLS)),
activeSizes = _.uniq([].concat(argv.size || SIZES)),
activeTests = _.uniq([].concat(argv.test || TESTS)),
activeNetworks = _.uniq([].concat(argv.network || NETWORKS)),
totalResults = []
;

if (argv.help || argv.h) {
	const msg = `

Usage:
${process.argv[1]} [OPTIONS]

OPTIONS:
	--help, -h: show this help
	--type <type>: use only servers of type <type>, normally 1 or 3. May be invoked multiple times. Default is all types.
	--protocol <protocol>: test only protocol <protocol>, normally UDP or TCP. May be invoked multiple times. Default is all of: ${PROTOCOLS.join(" ")}
	--size <size>: test packets of size <size>, an integer. May be invoked multiple times. Default is all of: ${SIZES.join(" ")}
	--test <test>: test to perform. May be invoked multiple times. Default is all of: ${TESTS.join(" ")}
	--network <network>: network test to perform. May be invoked multiple times. Default is all of: ${NETWORKS.join(" ")}
	--project <project>: use existing project ID <project> instead of creating new one
	--keep: do not destroy servers or project at end of test run
	`
	;
	console.log(msg);
	process.exit(1);
}

log(`using devices: ${_.keys(activeDevs).join(" ")}`);
log(`using packet sizes: ${activeSizes.join(" ")}`);
log(`using protocols: ${activeProtocols.join(" ")}`);
log(`using tests: ${activeTests.join(" ")}`);
log(`using network tests: ${activeNetworks.join(" ")}`);



// get the public key in the right format
if (fs.existsSync(SSHFILE)) {
	pair = jsonfile.readFileSync(SSHFILE);
} else {
	pair = keypair();
	pair.sshPublicKey = forge.ssh.publicKeyToOpenSSH(forge.pki.publicKeyFromPem(pair.public),"ULL-test-user@atomicinc.com");
	jsonfile.writeFileSync(SSHFILE,pair);
}


async.waterfall([
	// if asked for existing project, see if it exists
	function (cb) {
		if (projId) {
			pkt.getProjects(projId,{},function (err,data) {
				if (err || !data || !data.id) {
					let msg = "FAIL: cannot use project "+projId+" which does not exist";
					log(msg);
					cb(msg);
				} else {
					cb(null);
				}
			});
		} else {
			cb(null);
		}
	},
	// create a new project
	function (cb) {
		if (!projId) {
			log("creating new project");
			pkt.addProject({name:projName},cb);
		} else {
			log("reusing existing project");
			cb(null,{id:projId});
		}
	},
	// check if this keypair exists or add it
	function (res,cb) {
		projId = res.id;
		log("project ready: "+projId);
		pkt.getSshkeys(false,cb);
	},
	function (res,cb) {
		// check for our key
		let existingKey = _.find(res.ssh_keys,{key:pair.sshPublicKey});
		if (existingKey) {
			pair.id = existingKey.id;
			log("ssh key already in system: "+pair.id);
			cb(null);
		} else {
			log("key not in system, adding");
			// now install the key as a new key for this user
			pkt.addSshkey({label: "temporary key for "+projName,key:pair.sshPublicKey}, function (err,data) {
				if (err) {
					log("failed to install ssh public key");
				} else {
					pair.id = data.id;
					log("installed ssh key "+pair.id);
				}
				cb(err);
			});
		}
	},
	// get the existing hosts for this project
	function (cb) {
		log("checking existing devices");
		pkt.getDevices(projId,false,{},cb);
	},
	// add the devices we need unless they already exist
	function (res,cb) {
		log("making new devices if needed");
		let devsToCreate = _.keys(activeDevs);
		// see if it already exists
		var existing = _.map(res.devices,"hostname");
		async.each(devsToCreate,function (item,callback) {
			if (_.indexOf(existing,item) > -1) {
				log(item+": already exists");
				callback(null);
			} else {
				//closure to handle each correctly
				(function(item) {
					log("creating "+item);
					pkt.addDevice(projId,{hostname: item, plan: "baremetal_"+devices[item].type, facility: "ewr1", operating_system:"centos_7"},function (err,data) {
						if(err) {
							log(item+": error creating");
							log(err);
							log(data);
						} else {
							log(item+": created");
							devices[item].id = data.id;
						}
						callback(err);
					});
				})(item);
			}
		},cb);
	},
	// wait for all servers to be ready
	function (cb) {
		log("all servers created");
		// how do we wait for all the devices to be ready?
		// we check the state of each one until it is ready
		log("waiting for all devices to be ready");
		var waitingFor = _.keys(activeDevs).length;
		async.whilst(
			function () {return waitingFor > 0;},
			function (callback) {
				// check each device
				// only check those that are not ready
				let devsToCheck = _.keys(_.omitBy(activeDevs,{ready:true}));
				log("checking "+devsToCheck.join(","));
				pkt.getDevices(projId,false,{},function (err,data) {
					// check each device and see its state
					if (err) {
						log("error retrieving all devices");
						callback(err);
					} else {
						_.each(devsToCheck,function (name) {
							let item = _.find(data.devices,{hostname:name});
							if (item && item.state && item.state === "active" && name && !devices[name].ready) {
								log(name+ " ready");
								// save my private IP
								devices[name].ip_public = _.find(item.ip_addresses, {public:true,address_family:4});
								devices[name].ip_private = _.find(item.ip_addresses, {public:false,address_family:4});
								devices[name].ready = true;
								waitingFor--;
							}
						});
						if (waitingFor > 0) {
							log("waiting "+CHECKDELAY+" seconds to check servers");
							setTimeout(function () {
								callback();
							},CHECKDELAY*1000);
						} else {
							callback();
						}
					}
				});
			},
			function (err) {
				if (err) {
					log("error checking server status");
				} else {
					log("all devices ready");
				}
				cb(err);
			}
		);
	},
	// upload the scripts
	function (cb) {
		log("uploading scripts");
		async.each(_.keys(activeDevs), function (item,cb) {
			// get the IP for the device
			let ipaddr = devices[item].ip_public.address;
			log(item+": uploading scripts to "+ipaddr);
			scp.scp('upload',{
				host: ipaddr,
				username: 'root',
				privateKey: pair.private,
				path: '/root/network-tests/'
			},function (err) {
				if (err) {
					log(item+": failed to upload scripts to "+ipaddr);
				} else {
					log(item+": successfully uploaded scripts to "+ipaddr);
				}
				cb(err);
			});
		}, function (err) {
			if (err) {
				log("failed to upload scripts");
			} else {
				log("scripts uploaded to all servers");
			}
			cb(err);
		});		
	},
	// run installs
	function (cb) {
		log("installing software");
		async.each(_.keys(activeDevs), function (item,cb) {
			// get the private IP for the device
			let ipaddr = devices[item].ip_public.address;
			log(item+": installing software on "+ipaddr);
			var session = new ssh({
				host: ipaddr,
				user: "root",
				key: pair.private
			});
			session
				.exec('network-tests/scripts/installnetperf.sh',{
					exit: function (code) {
						if (code !== 0) {
							log(item+": Failed to install netperf");
							session.end();
						}
					}
				})
				.exec('network-tests/scripts/installdocker.sh',{
					exit: function (code) {
						if (code !== 0) {
							log(item+": Failed to install docker");
							session.end();
						}
					}
				})
				.exec('docker build -t netperf network-tests/image',{
					exit: function (code) {
						if (code !== 0) {
							log(item+": Failed to build netperf image");
							session.end();
						}
					}
				})
				;
				session.on('error',function (err) {
					log(item+": error install software");
					log(err);
					session.end();
					cb(item+": ssh connection failed");
				})
				.on('close',function (hadError) {
					if (!hadError) {
						log(item+": complete");
						cb(null);
					}
				});
				session.start();
		}, function (err) {
			if (err) {
				log("failed to install software");
			} else {
				log("software installed in all servers");
			}
			cb(err);
		});		
	},
	// run all of our tests
	
	// first run our benchmark bare metal tests
	function (cb) {
		if (_.indexOf(activeTests,"metal") > -1) {
			log("running metal tests");
			// make the list of what we will test
			let tests = genTestList({protocols:activeProtocols,sizes:activeSizes,networks:activeNetworks,devices:activeDevs, test:"metal", port:NETSERVERPORT, reps: REPETITIONS});
			runHostTests(tests,cb);
		} else {
			log("skipping metal tests");
			cb(null,null);
		}
	},
	// and capture the output
	function (results,cb) {
		// save the results
		log("host tests complete");
		totalResults.push.apply(totalResults,results||[]);


		// now run container tests - be sure to exclude metal
		async.each(_.without(activeTests,'metal'),function (test,cb) {
			// now run container with net=host tests
			log("running net="+test+" tests");
			// make the list of what we will test
			let tests = genTestList({protocols:activeProtocols,sizes:activeSizes,networks:activeNetworks,devices:activeDevs, test:test, port:NETSERVERPORT, reps: REPETITIONS});
			runContainerTests(tests,test,function (err,data) {
				if(err) {
					log("net="+test+" errors");
				} else {
					log("net="+test+" complete");
					totalResults.push.apply(totalResults,data||[]);
				}
				cb(err);
			});
		},cb);
	},

	// destroy all hosts
	function (cb) {
		log("container tests complete");


		if (keepItems) {
			log("command-line flag not to destroy servers");
			cb(null,false);
		} else {
			log("destroying servers");
			async.each(_.keys(activeDevs), function (item,callback) {
				pkt.removeDevice(devices[item].id,function (err) {
					if (!err) {
						log(item +" removed");
					} else {
						log(item+ " removal failed! Please check console");
						log(err);
					}
					// always callback without error, since we want the other devices removed too
					callback(err);
				});
			},function (err) {
				if (err) {
					log("err destroying devices. Please check on Packet console to avoid unnecessary charges.");
					cb(err);
				} else {
					log("all devices destroyed");
					cb(null,true);
				}
			});
		}
	},
	// destroy the project
	function (res,cb) {
		if (res) {
			log("destroying project");
			pkt.removeProject(projId,function (err) {
				if (err) {
					log("err destroying project "+projId+". Please check on Packet console.");
				} else {
					log("project "+projId+" destroyed");
				}
				cb(null,true);
			});
		} else {
			log("not destroying project as servers not destroyed");
			cb(null,false);
		}
	},
	// destroy the ssh key
	function (res,cb) {
		if (res) {
			log("removing ssh key");
			pkt.removeSshkey(pair.id,function (err) {
				if (err) {
					log("err removing ssh key "+pair.id+". Please check on Packet console.");
				} else {
					log("ssh key "+pair.id+" removed");
				}
				cb(null);
			});
		} else {
			log("not removing ssh key as project not destroyed");
			cb(null);
		}
	}
	
],function (err) {
	log("test run complete");
	if (err) {
		log(err);
	} else {
		console.log(totalResults);
	}
});

