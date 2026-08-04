const CONFIG = Object.freeze({
  SPREADSHEET_ID: '17riM84qTJd1_XhLDrjO_a3j2tKUvtCSKKdXQHnn0f5U',
  TIME_ZONE: 'Asia/Seoul',
  SESSION_HOURS: 12,
  DEVICE_OFFLINE_MS: 45000,
  SHEETS: Object.freeze({
    DEVICES: 'DEVICES',
    COMMANDS: 'COMMANDS',
    LOGS: 'LOGS',
    USERS: 'USERS',
    SESSIONS: 'SESSIONS'
  })
});

const DEFAULT_DEVICES = Object.freeze([
  { deviceId: 'TECH_1', deviceName: '기술실 1번', room: 'TECH' },
  { deviceId: 'TECH_2', deviceName: '기술실 2번', room: 'TECH' },
  { deviceId: 'TECH_3D', deviceName: '3D 작업실', room: 'TECH_3D' }
]);

function setup() {
  const ss = getSpreadsheet_();
  ss.setSpreadsheetTimeZone(CONFIG.TIME_ZONE);

  ensureSheet_(ss, CONFIG.SHEETS.DEVICES, [
    'deviceId', 'deviceName', 'room', 'deviceSecret', 'enabled',
    'lastSeen', 'lastCommand', 'lastResult', 'updatedAt'
  ]);
  ensureSheet_(ss, CONFIG.SHEETS.COMMANDS, [
    'commandId', 'createdAt', 'deviceId', 'deviceName', 'command',
    'status', 'requestedBy', 'executedAt', 'result'
  ]);
  ensureSheet_(ss, CONFIG.SHEETS.LOGS, [
    'timestamp', 'type', 'deviceId', 'userId', 'message', 'details'
  ]);
  ensureSheet_(ss, CONFIG.SHEETS.USERS, [
    'userId', 'displayName', 'passwordSalt', 'passwordHash', 'role',
    'enabled', 'createdAt', 'lastLoginAt'
  ]);
  ensureSheet_(ss, CONFIG.SHEETS.SESSIONS, [
    'token', 'userId', 'displayName', 'role', 'createdAt', 'expiresAt', 'active'
  ]);

  ensureDefaultDevices_(ss);
  const admin = ensureInitialAdmin_(ss);
  appendLog_('SETUP', '', 'SYSTEM', '초기 설정 완료', {
    devices: DEFAULT_DEVICES.length,
    adminCreated: admin.created
  });

  const result = {
    ok: true,
    message: '초기 설정이 완료되었습니다.',
    spreadsheetUrl: ss.getUrl(),
    adminCreated: admin.created,
    adminId: admin.userId
  };

  if (admin.temporaryPassword) {
    result.temporaryPassword = admin.temporaryPassword;
    Logger.log('Temporary admin ID: ' + admin.userId);
    Logger.log('Temporary admin password: ' + admin.temporaryPassword);
  }

  Logger.log(JSON.stringify(result));
  return result;
}

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  return handleRequest_(params, params.callback || '');
}

function doPost(e) {
  const params = parsePostBody_(e);
  return handleRequest_(params, params.callback || '');
}

function handleRequest_(params, callback) {
  try {
    const action = String(params.action || 'health').trim();
    let result;

    switch (action) {
      case 'health': result = health_(); break;
      case 'login': result = login_(params); break;
      case 'validateSession': result = validateSessionAction_(params); break;
      case 'logout': result = logout_(params); break;
      case 'mqttConfig': result = mqttConfig_(params); break;
      case 'overview': result = overview_(params); break;
      case 'logMqttCommand': result = logMqttCommand_(params); break;
      case 'logMqttResult': result = logMqttResult_(params); break;
      case 'heartbeat': result = heartbeat_(params); break;
      default: throw new Error('지원하지 않는 action입니다: ' + action);
    }

    return output_(result, callback);
  } catch (error) {
    return output_({
      ok: false,
      message: error && error.message ? error.message : String(error)
    }, callback);
  }
}

function health_() {
  return {
    ok: true,
    service: 'HG TECH AC API',
    version: '2.0.0',
    serverTime: formatDate_(new Date())
  };
}

function login_(params) {
  const userId = requireText_(params.userId, 'userId');
  const passwordDigest = requireText_(params.passwordDigest, 'passwordDigest');
  const user = findUser_(userId);

  if (!user || !user.enabled) {
    appendLog_('LOGIN_FAILED', '', userId, '존재하지 않거나 비활성화된 사용자', {});
    throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.');
  }

  const calculated = digest_(passwordDigest + ':' + user.passwordSalt);
  if (calculated !== user.passwordHash) {
    appendLog_('LOGIN_FAILED', '', userId, '비밀번호 불일치', {});
    throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.');
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CONFIG.SESSION_HOURS * 60 * 60 * 1000);
  const token = createToken_();
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.SHEETS.SESSIONS);

  sheet.appendRow([token, user.userId, user.displayName, user.role, now, expiresAt, true]);
  getSpreadsheet_().getSheetByName(CONFIG.SHEETS.USERS).getRange(user.row, 8).setValue(now);
  appendLog_('LOGIN_SUCCESS', '', user.userId, '관리자 로그인 성공', {});

  return {
    ok: true,
    token: token,
    userId: user.userId,
    displayName: user.displayName,
    role: user.role,
    expiresAt: expiresAt.getTime()
  };
}

function validateSessionAction_(params) {
  const session = requireSession_(params.token);
  return {
    ok: true,
    userId: session.userId,
    displayName: session.displayName,
    role: session.role,
    expiresAt: session.expiresAt.getTime()
  };
}

function logout_(params) {
  const token = requireText_(params.token, 'token');
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.SHEETS.SESSIONS);
  const lastRow = sheet.getLastRow();

  if (lastRow >= 2) {
    const rows = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) === token) {
        sheet.getRange(i + 2, 7).setValue(false);
        appendLog_('LOGOUT', '', String(rows[i][1]), '관리자 로그아웃', {});
        break;
      }
    }
  }

  return { ok: true };
}

function mqttConfig_(params) {
  requireSession_(params.token);
  const props = PropertiesService.getScriptProperties();
  const url = String(props.getProperty('MQTT_URL') || '').trim();
  const username = String(props.getProperty('MQTT_USERNAME') || '').trim();
  const password = String(props.getProperty('MQTT_PASSWORD') || '');
  const topicPrefix = String(props.getProperty('MQTT_TOPIC_PREFIX') || 'hg-tech-ac').trim();

  return {
    ok: true,
    configured: Boolean(url && username && password),
    url: url,
    username: username,
    password: password,
    topicPrefix: topicPrefix || 'hg-tech-ac',
    offlineAfterMs: CONFIG.DEVICE_OFFLINE_MS
  };
}

function overview_(params) {
  requireSession_(params.token);
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.SHEETS.DEVICES);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, devices: [] };

  const rows = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  const devices = rows.filter(function(row) {
    return String(row[0]).trim() !== '';
  }).map(function(row) {
    return {
      deviceId: String(row[0]),
      deviceName: String(row[1]),
      room: String(row[2]),
      enabled: row[4] === true,
      lastSeen: row[5] instanceof Date ? formatDate_(row[5]) : '',
      lastCommand: String(row[6] || ''),
      lastResult: String(row[7] || ''),
      updatedAt: row[8] instanceof Date ? formatDate_(row[8]) : ''
    };
  });

  return { ok: true, devices: devices };
}

function logMqttCommand_(params) {
  const session = requireSession_(params.token);
  const commandId = requireText_(params.commandId, 'commandId');
  const deviceId = requireText_(params.deviceId, 'deviceId');
  const command = String(params.command || 'PRESS_POWER').trim();
  const device = getDevice_(deviceId, false, '');
  const now = new Date();

  getSpreadsheet_().getSheetByName(CONFIG.SHEETS.COMMANDS).appendRow([
    commandId, now, device.deviceId, device.deviceName, command,
    'SENT_MQTT', session.userId, '', ''
  ]);

  updateDeviceFields_(device.row, { lastCommand: command + ' 전송', updatedAt: now });
  appendLog_('MQTT_COMMAND', deviceId, session.userId, 'MQTT 명령 전송', {
    commandId: commandId,
    command: command
  });

  return { ok: true, commandId: commandId, status: 'SENT_MQTT' };
}

function logMqttResult_(params) {
  const session = requireSession_(params.token);
  const commandId = requireText_(params.commandId, 'commandId');
  const deviceId = requireText_(params.deviceId, 'deviceId');
  const success = String(params.success || 'true').toLowerCase() !== 'false';
  const resultText = String(params.result || (success ? 'SUCCESS' : 'FAILED')).slice(0, 500);
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.SHEETS.COMMANDS);
  const lastRow = sheet.getLastRow();
  const now = new Date();

  if (lastRow >= 2) {
    const rows = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
    for (let i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][0]) === commandId && String(rows[i][2]) === deviceId) {
        sheet.getRange(i + 2, 6).setValue(success ? 'DONE' : 'FAILED');
        sheet.getRange(i + 2, 8).setValue(now);
        sheet.getRange(i + 2, 9).setValue(resultText);
        break;
      }
    }
  }

  const device = getDevice_(deviceId, false, '');
  updateDeviceFields_(device.row, { lastSeen: now, lastResult: resultText, updatedAt: now });
  appendLog_('MQTT_RESULT', deviceId, session.userId, 'MQTT 실행 결과', {
    commandId: commandId,
    success: success,
    result: resultText
  });

  return { ok: true };
}

function heartbeat_(params) {
  const device = authenticateDevice_(params);
  const now = new Date();
  updateDeviceFields_(device.row, { lastSeen: now, updatedAt: now });
  return { ok: true, deviceId: device.deviceId, serverTime: formatDate_(now) };
}

function ensureInitialAdmin_(ss) {
  const sheet = ss.getSheetByName(CONFIG.SHEETS.USERS);
  const lastRow = sheet.getLastRow();

  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat().map(String);
    if (ids.indexOf('admin') !== -1) {
      return { created: false, userId: 'admin', temporaryPassword: '' };
    }
  }

  const temporaryPassword = 'HG-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  const passwordDigest = digest_(temporaryPassword);
  const salt = Utilities.getUuid().replace(/-/g, '');
  const passwordHash = digest_(passwordDigest + ':' + salt);

  sheet.appendRow([
    'admin', '기술실 관리자', salt, passwordHash,
    'admin', true, new Date(), ''
  ]);

  return { created: true, userId: 'admin', temporaryPassword: temporaryPassword };
}

function resetAdminPassword() {
  const NEW_PASSWORD = '여기에_새_비밀번호_입력';
  if (NEW_PASSWORD.indexOf('여기에_') === 0) {
    throw new Error('resetAdminPassword()의 NEW_PASSWORD 값을 먼저 수정하세요.');
  }

  const user = findUser_('admin');
  if (!user) throw new Error('admin 사용자가 없습니다. setup()을 먼저 실행하세요.');

  const salt = Utilities.getUuid().replace(/-/g, '');
  const passwordDigest = digest_(NEW_PASSWORD);
  const passwordHash = digest_(passwordDigest + ':' + salt);
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.SHEETS.USERS);
  sheet.getRange(user.row, 3).setValue(salt);
  sheet.getRange(user.row, 4).setValue(passwordHash);
  Logger.log('admin 비밀번호를 변경했습니다.');
}

function checkMqttProperties() {
  const props = PropertiesService.getScriptProperties();
  const result = {
    MQTT_URL: Boolean(props.getProperty('MQTT_URL')),
    MQTT_USERNAME: Boolean(props.getProperty('MQTT_USERNAME')),
    MQTT_PASSWORD: Boolean(props.getProperty('MQTT_PASSWORD')),
    MQTT_TOPIC_PREFIX: props.getProperty('MQTT_TOPIC_PREFIX') || 'hg-tech-ac'
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function ensureDefaultDevices_(ss) {
  const sheet = ss.getSheetByName(CONFIG.SHEETS.DEVICES);
  const lastRow = sheet.getLastRow();
  const existingIds = lastRow >= 2
    ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat().map(String)
    : [];

  DEFAULT_DEVICES.forEach(function(device) {
    if (existingIds.indexOf(device.deviceId) !== -1) return;
    sheet.appendRow([
      device.deviceId, device.deviceName, device.room, createToken_(), true,
      '', '', '', new Date()
    ]);
  });
}

function ensureSheet_(ss, sheetName, headers) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#D9EAF7');
  sheet.autoResizeColumns(1, headers.length);
  return sheet;
}

function findUser_(userId) {
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.SHEETS.USERS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const rows = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) !== userId) continue;
    return {
      row: i + 2,
      userId: String(rows[i][0]),
      displayName: String(rows[i][1]),
      passwordSalt: String(rows[i][2]),
      passwordHash: String(rows[i][3]),
      role: String(rows[i][4]),
      enabled: rows[i][5] === true
    };
  }
  return null;
}

function requireSession_(tokenValue) {
  const token = requireText_(tokenValue, 'token');
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.SHEETS.SESSIONS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('로그인이 필요합니다.');

  const rows = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  const now = new Date();

  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][0]) !== token) continue;
    const expiresAt = rows[i][5] instanceof Date ? rows[i][5] : new Date(rows[i][5]);
    const active = rows[i][6] === true;

    if (!active || expiresAt.getTime() <= now.getTime()) {
      sheet.getRange(i + 2, 7).setValue(false);
      throw new Error('로그인 세션이 만료되었습니다.');
    }

    return {
      row: i + 2,
      token: token,
      userId: String(rows[i][1]),
      displayName: String(rows[i][2]),
      role: String(rows[i][3]),
      expiresAt: expiresAt
    };
  }

  throw new Error('유효하지 않은 로그인 세션입니다.');
}

function authenticateDevice_(params) {
  const deviceId = requireText_(params.deviceId, 'deviceId');
  const deviceSecret = requireText_(params.deviceSecret, 'deviceSecret');
  return getDevice_(deviceId, true, deviceSecret);
}

function getDevice_(deviceId, checkSecret, suppliedSecret) {
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.SHEETS.DEVICES);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('DEVICES 시트가 비어 있습니다. setup()을 실행하세요.');

  const rows = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) !== deviceId) continue;
    if (checkSecret && String(rows[i][3]) !== suppliedSecret) {
      throw new Error('장치 인증에 실패했습니다.');
    }
    if (rows[i][4] !== true) throw new Error('비활성화된 장치입니다.');

    return {
      row: i + 2,
      deviceId: String(rows[i][0]),
      deviceName: String(rows[i][1]),
      room: String(rows[i][2]),
      deviceSecret: String(rows[i][3])
    };
  }
  throw new Error('등록되지 않은 장치입니다: ' + deviceId);
}

function updateDeviceFields_(rowNumber, fields) {
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.SHEETS.DEVICES);
  const columns = { lastSeen: 6, lastCommand: 7, lastResult: 8, updatedAt: 9 };
  Object.keys(fields).forEach(function(key) {
    if (columns[key]) sheet.getRange(rowNumber, columns[key]).setValue(fields[key]);
  });
}

function appendLog_(type, deviceId, userId, message, details) {
  getSpreadsheet_().getSheetByName(CONFIG.SHEETS.LOGS).appendRow([
    new Date(), type || '', deviceId || '', userId || '', message || '',
    details ? JSON.stringify(details) : ''
  ]);
}

function getSpreadsheet_() {
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
}

function parsePostBody_(e) {
  const params = Object.assign({}, e && e.parameter ? e.parameter : {});
  const contents = e && e.postData && e.postData.contents
    ? String(e.postData.contents).trim()
    : '';
  if (!contents) return params;

  try {
    const parsed = JSON.parse(contents);
    if (parsed && typeof parsed === 'object') return Object.assign(params, parsed);
  } catch (ignore) {}

  contents.split('&').forEach(function(part) {
    const pair = part.split('=');
    if (!pair[0]) return;
    const key = decodeURIComponent(pair[0].replace(/\+/g, ' '));
    const value = decodeURIComponent((pair[1] || '').replace(/\+/g, ' '));
    params[key] = value;
  });
  return params;
}

function output_(data, callback) {
  const json = JSON.stringify(data);
  const validCallback = String(callback || '').trim();
  if (validCallback && /^[A-Za-z_$][0-9A-Za-z_$\.]*$/.test(validCallback)) {
    return ContentService.createTextOutput(validCallback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function requireText_(value, fieldName) {
  const text = String(value || '').trim();
  if (!text) throw new Error(fieldName + ' 값이 필요합니다.');
  return text;
}

function digest_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text))
    .map(function(byte) {
      const value = byte < 0 ? byte + 256 : byte;
      return value.toString(16).padStart(2, '0');
    })
    .join('');
}

function createToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

function formatDate_(date) {
  return Utilities.formatDate(date, CONFIG.TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
}
