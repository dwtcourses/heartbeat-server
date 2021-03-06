let uuid = require('uuid/v4');
let cryptoAES = require('../utils/cryptoAES');
let logger = require('../utils/logger');

function processRequest(request, storage, timeNowISOString, sharedKey) {
  let heartbeat_data;
  try {
    heartbeat_data = cryptoAES.decryptToJSON(request.body.heartbeat_token, sharedKey);
  } catch(_err) {
    return notAcceptableResponse();
  }

  return storage.fetchUserSessionData(heartbeat_data.user_id)
    .then(processHeartbeatData(heartbeat_data, storage, request, sharedKey))
    .catch((errorMsg) => console.log(errorMsg))
    .then((heartbeat_response) => {
      storage.executePostActions();
      return heartbeat_response;
    });
}

function processHeartbeatData(heartbeatData, storage, request, sharedKey) {
  return function (userSessionData) {
    let inputData = {
      user_id: heartbeatData.user_id,
      session_id: heartbeatData.session_id,
      new_timestamp: getTimeNowISOString(),
      session_limit: heartbeatData.session_limit,
      checking_threshold: heartbeatData.checking_threshold,
      sessions_edge: heartbeatData.sessions_edge,
      sessions: userSessionData.sessions
    };

    refreshActiveSessions(inputData, storage, heartbeatData);
    logger.verbose('Active sessions', JSON.stringify(inputData.sessions));

    if (sessionLimitExceeded(inputData, heartbeatData.reject_strategy)) return activeSessionLimitExceededResponse();

    let outputData = processInputData(inputData, heartbeatData, sharedKey);

    storage.addPostAction('setSession', inputData.user_id,
      inputData.session_id, outputData.sessionConfig);

    if (!!request.body.progress) {
      storage.addPostAction('updateProgress', inputData.user_id,
        heartbeatData.asset_id, request.body.progress);
    }

    return successfulResponse(outputData.heartbeatResponse);
  }
}

function processInputData(inputData, heartbeatData, sharedKey) {
  let sessionConfig = {
    timestamp: inputData.new_timestamp,
    hit_counter: getHitCounter(inputData.sessions, inputData.session_id) + 1
  };
  let newHeartbeatData = Object.assign({}, heartbeatData);
  newHeartbeatData.timestamp = inputData.new_timestamp;

  if (needsToCreateNewSession(inputData.session_id, inputData.sessions,
      heartbeatData, inputData.new_timestamp)) {
    inputData.session_id = uuid();
    logger.verbose(`Creating new session with :session_id = '${inputData.session_id}'`);

    sessionConfig.started_at = inputData.new_timestamp;
    newHeartbeatData.started_at = inputData.new_timestamp;
  } else {
    sessionConfig.started_at = heartbeatData.started_at;
  }

  let heartbeatResponse = createHeartbeatResponse(inputData.session_id, newHeartbeatData, sharedKey);
  logger.verbose('New heartbeat response', JSON.stringify(heartbeatResponse));

  return {
    sessionConfig: sessionConfig,
    heartbeatResponse: heartbeatResponse
  }
}

function getTimeNowISOString() {
  return (new Date()).toISOString();
}

function getHitCounter(sessions, session_id) {
  let session = sessions[session_id];
  return session && session.hit_counter ? +session.hit_counter : 0;
}

function refreshActiveSessions(inputData, storage, heartbeat_data) {
  if (inputData.sessions == null) return {};
  let active_sessions = {};

  for (sessionId of Object.keys(inputData.sessions)) {
    let session = inputData.sessions[sessionId];
    if (!timeExceeded(session.timestamp, heartbeat_data.heartbeat_cycle,
        heartbeat_data.cycle_upper_tolerance, inputData.new_timestamp)) {
      active_sessions[sessionId] = session;
    } else {
      storage.addPostAction('deleteSession', heartbeat_data.user_id, sessionId)
    }
  }

  inputData.sessions = active_sessions;
}

function sessionLimitExceeded(inputData, rejectStrategy) {
  let sessionIds = Object.keys(inputData.sessions)
    .filter(checkingThresholdSatisfied(inputData.sessions, inputData.checking_threshold))
    .sort(compareSessionsByStartedAt(inputData.sessions, rejectStrategy));

  let sessionsEdgeExceeded = Object.keys(inputData.sessions).length > +inputData.sessions_edge;
  let sessionOverLimit = sessionIds.indexOf(inputData.session_id) >= +inputData.session_limit;

  let sessionLimitExceeded = sessionsEdgeExceeded || sessionOverLimit;
  if (sessionLimitExceeded) {
    logger.verbose('Session limit exceeded', {
      sessionsEdgeExceeded: sessionsEdgeExceeded,
      sessionOverLimit: sessionOverLimit
    });
  }

  return sessionLimitExceeded;
}

function checkingThresholdSatisfied(sessions, checkingThreshold) {
  return function (sessionId) {
    let session = sessions[sessionId];
    return !!session && +session.hit_counter >= +checkingThreshold;
  };
}

function compareSessionsByStartedAt(sessions, rejectStrategy) {
  return function (sessionId1, sessionId2) {
    let time1 = (new Date(sessions[sessionId1].started_at)).getTime();
    let time2 = (new Date(sessions[sessionId2].started_at)).getTime();

    if (rejectStrategy === 'MOST_RECENT') return orderLeastRecentFirst(time1, time2);
    else if (rejectStrategy === 'LEAST_RECENT') return orderMostRecentFirst(time1, time2);
    else return orderMostRecentFirst(time1, time2);
  }
}

function orderLeastRecentFirst(time1, time2) {
  if (time1 < time2) return -1;
  if (time1 > time2) return 1;

  return 0;
}

function orderMostRecentFirst(time1, time2) {
  if (time1 > time2) return -1;
  if (time1 < time2) return 1;

  return 0;
}

function createHeartbeatResponse(sessionId, heartbeatData, sharedKey) {
  let modifiedHeartbeatData = {
    user_id: heartbeatData.user_id,
    session_id: sessionId,
    asset_id: heartbeatData.asset_id,
    heartbeat_cycle: heartbeatData.heartbeat_cycle,
    reject_strategy: heartbeatData.reject_strategy,
    cycle_lower_tolerance: heartbeatData.cycle_lower_tolerance,
    cycle_upper_tolerance: heartbeatData.cycle_upper_tolerance,
    session_limit: heartbeatData.session_limit,
    checking_threshold: heartbeatData.checking_threshold,
    sessions_edge: heartbeatData.sessions_edge,
    started_at: heartbeatData.started_at,
    timestamp: heartbeatData.timestamp
  };

  return { heartbeat_token: cryptoAES.encrypt(modifiedHeartbeatData, sharedKey) };
}

function needsToCreateNewSession(sessionId, sessions, heartbeatData, newTimestamp) {
  let session = sessions[sessionId];

  let hbDataFromBackend = heartbeatDataFromBackend(heartbeatData);
  let hbSessionMissing = sessionMissing(sessionId, sessions);
  let hbNotExpected = session ?
    heartbeatNotExpected(session.timestamp, heartbeatData.timestamp) : false;
  let hbReceivedTooEarly = session ?
    heartbeatReceivedTooEarly(session.timestamp, newTimestamp,
    heartbeatData.heartbeat_cycle, heartbeatData.cycle_lower_tolerance) : false;

  let needsToCreateNewSession = hbDataFromBackend ||
    hbSessionMissing || hbNotExpected || hbReceivedTooEarly;

  if (needsToCreateNewSession) {
    logger.verbose('Needs to create a new session', {
      heartbeat_data_from_backend: hbDataFromBackend,
      session_missing: hbSessionMissing,
      heartbeat_not_expected: hbNotExpected,
      heartbeat_received_too_early: hbReceivedTooEarly
    });
  }

  return needsToCreateNewSession;
}

function heartbeatDataFromBackend(heartbeatData) {
  return !isDefined(heartbeatData.session_id);
}

let isDefined = (variable) => typeof variable !== 'undefined';

let successfulResponse = function(response_body) {
  return {
    status: 200,
    body: response_body
  }
};

let activeSessionLimitExceededResponse = function () {
  return {
    status: 412,
    body: {
      error: 'You have exceeded the maximum allowed number of devices.'
    }
  }
};

let notAcceptableResponse = function () {
  return {
    status: 406,
    body: {
      error: 'Heartbeat token is not valid.'
    }
  }
};

function sessionMissing(sessionId, sessions) {
  return sessions[sessionId] == null;
}

function heartbeatNotExpected(timestamp, receivedTimestamp) {
  return (new Date(timestamp)).getTime() !== (new Date(receivedTimestamp)).getTime();
}

function heartbeatReceivedTooEarly(timestamp, newTimestamp, heartbeatCycle, cycleLowerTolerance) {
  let deltaT = (new Date(newTimestamp)).getTime() - (new Date(timestamp)).getTime();
  let isTooEarly = deltaT < +heartbeatCycle * 1000 - +cycleLowerTolerance * 1000;
  if (isTooEarly) logger.verbose('Heartbeat received too early', {deltaTms: deltaT});

  return isTooEarly;
}

function timeExceeded(timestamp, heartbeatCycle, cycleUpperTolerance, timeNow) {
  return new Date(new Date(timestamp).getTime() +
      +heartbeatCycle * 1000 + +cycleUpperTolerance * 1000) < new Date(timeNow);
}

module.exports = {
  processRequest: processRequest
};
