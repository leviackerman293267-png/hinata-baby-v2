const fs = require("fs-extra");
const nullAndUndefined = [undefined, null];

function getType(obj) {
	return Object.prototype.toString.call(obj).slice(8, -1);
}

function getRole(threadData, senderID) {
	const adminBot = global.GoatBot.config.adminBot || [];
	if (!senderID) return 0;
	const adminBox = threadData ? threadData.adminIDs || [] : [];
	return adminBot.includes(senderID) ? 2 : adminBox.includes(senderID) ? 1 : 0;
}

function getText(type, reason, time, targetID, lang) {
	const utils = global.utils;
	if (type == "userBanned") return utils.getText({ lang, head: "handlerEvents" }, "userBanned", reason, time, targetID);
	if (type == "threadBanned") return utils.getText({ lang, head: "handlerEvents" }, "threadBanned", reason, time, targetID);
	if (type == "onlyAdminBox") return utils.getText({ lang, head: "handlerEvents" }, "onlyAdminBox");
	if (type == "onlyAdminBot") return utils.getText({ lang, head: "handlerEvents" }, "onlyAdminBot");
}

function replaceShortcutInLang(text, prefix, commandName) {
	return text.replace(/\{(?:p|prefix)\}/g, prefix).replace(/\{(?:n|name)\}/g, commandName).replace(/\{pn\}/g, `${prefix}${commandName}`);
}

function getRoleConfig(utils, command, isGroup, threadData, commandName) {
	let roleConfig = typeof command.config.role == "object" && !Array.isArray(command.config.role) ? command.config.role : { onStart: command.config.role || 0 };
	if (isGroup) roleConfig.onStart = threadData.data.setRole?.[commandName] ?? roleConfig.onStart;
	for (const key of ["onChat", "onStart", "onReaction", "onReply"]) {
		if (roleConfig[key] == undefined) roleConfig[key] = roleConfig.onStart;
	}
	return roleConfig;
}

function isBannedOrOnlyAdmin(userData, threadData, senderID, threadID, isGroup, commandName, message, lang) {
	const config = global.GoatBot.config;
	const { adminBot, hideNotiMessage } = config;
	if (userData.banned.status) {
		if (!hideNotiMessage.userBanned) message.reply(getText("userBanned", userData.banned.reason, userData.banned.date, senderID, lang));
		return true;
	}
	if (config.adminOnly.enable && !adminBot.includes(senderID) && !config.adminOnly.ignoreCommand.includes(commandName)) {
		if (!hideNotiMessage.adminOnly) message.reply(getText("onlyAdminBot", null, null, null, lang));
		return true;
	}
	if (isGroup) {
		if (threadData.data.onlyAdminBox && !threadData.adminIDs.includes(senderID) && !(threadData.data.ignoreCommanToOnlyAdminBox || []).includes(commandName)) {
			if (!threadData.data.hideNotiMessageOnlyAdminBox) message.reply(getText("onlyAdminBox", null, null, null, lang));
			return true;
		}
		if (threadData.banned.status) {
			if (!hideNotiMessage.threadBanned) message.reply(getText("threadBanned", threadData.banned.reason, threadData.banned.date, threadID, lang));
			return true;
		}
	}
	return false;
}

function createGetText2(langCode, pathCustomLang, prefix, command) {
	const commandName = command.config.name;
	let customLang = fs.existsSync(pathCustomLang) ? require(pathCustomLang)[commandName]?.text || {} : {};
	return function (key, ...args) {
		let lang = command.langs?.[langCode]?.[key] || customLang[key] || "";
		lang = replaceShortcutInLang(lang, prefix, commandName);
		for (let i = args.length - 1; i >= 0; i--) lang = lang.replace(new RegExp(`%${i + 1}`, "g"), args[i]);
		return lang || `❌ Key "${key}" not found for "${commandName}"`;
	};
}

module.exports = function (api, threadModel, userModel, dashBoardModel, globalModel, usersData, threadsData, dashBoardData, globalData) {
	const config = global.GoatBot.config;
	if (config.author !== "MahMUD") {
		console.log("\x1b[41m\x1b[37m%s\x1b[0m", "[ SYSTEM ERROR ] INVALID AUTHOR DETECTED!");
		console.log("\x1b[31m%s\x1b[0m", `[ ERROR ] Expected author: 'MahMUD', but found: '${config.author}'`);
		console.log("\x1b[33m%s\x1b[0m", "[ INFO ] Bot is shutting down to prevent unauthorized use.");
		process.exit(1); 
	}
   
	return async function (event, message) {
		const { utils, client, GoatBot } = global;
		const { getPrefix, log, getTime } = utils;
		const { configCommands: { envGlobal, envCommands, envEvents } } = GoatBot;
		const { body, messageID, threadID, isGroup } = event;

		if (!threadID) return;
		const senderID = event.userID || event.senderID || event.author;

		let threadData = global.db.allThreadData.find(t => t.threadID == threadID) || await threadsData.create(threadID);
		let userData = global.db.allUserData.find(u => u.userID == senderID) || await usersData.create(senderID);

		const prefix = getPrefix(threadID);
		const role = getRole(threadData, senderID);
		const langCode = threadData.data.lang || config.language || "en";

		const parameters = {
			api, usersData, threadsData, message, event, userModel, threadModel, prefix, dashBoardModel,
			globalModel, dashBoardData, globalData, envCommands, envEvents, envGlobal, role,
			removeCommandNameFromBody: (b, p, c) => b.replace(new RegExp(`^${p}(\\s+|)${c}`, "i"), "").trim()
		};

		async function onStart() {
			if (!body || !body.startsWith(prefix)) return;
			const args = body.slice(prefix.length).trim().split(/ +/);
			let commandName = args.shift().toLowerCase();
			let command = GoatBot.commands.get(commandName) || GoatBot.commands.get(GoatBot.aliases.get(commandName));

			if (!command) return;
			commandName = command.config.name;

			if (isBannedOrOnlyAdmin(userData, threadData, senderID, threadID, isGroup, commandName, message, langCode)) return;

			const roleConfig = getRoleConfig(utils, command, isGroup, threadData, commandName);
			if (roleConfig.onStart > role) return message.reply(`Only ${roleConfig.onStart == 1 ? "Admins" : "Bot Admins"} can use this!`);

			if (!client.countDown[commandName]) client.countDown[commandName] = {};
			const cooldown = (command.config.countDown || 1) * 1000;
			if (client.countDown[commandName][senderID] && Date.now() < client.countDown[commandName][senderID] + cooldown) {
				return message.reply("Slow down! Wait a bit.");
			}

			try {
				const getText2 = createGetText2(langCode, `${process.cwd()}/languages/cmds/${langCode}.js`, prefix, command);
				await command.onStart({ ...parameters, args, commandName, getLang: getText2 });
				client.countDown[commandName][senderID] = Date.now();
				log.info("COMMAND", `${commandName} executed by ${senderID}`);
			} catch (err) { log.err("COMMAND", commandName, err); }
		}

		async function onChat() {
			for (const key of (GoatBot.onChat || [])) {
				const command = GoatBot.commands.get(key);
				if (!command) continue;
				try {
					await command.onChat({ ...parameters, args: body ? body.split(/ +/) : [], commandName: command.config.name });
				} catch (err) { log.err("onChat", key, err); }
			}
		}

		async function onReply() {
			if (!event.messageReply) return;
			const Reply = GoatBot.onReply.get(event.messageReply.messageID);
			if (!Reply) return;
			const command = GoatBot.commands.get(Reply.commandName);
			if (command) {
				try {
					await command.onReply({ ...parameters, Reply, args: body ? body.split(/ +/) : [], commandName: Reply.commandName });
				} catch (err) { log.err("onReply", Reply.commandName, err); }
			}
		}

		async function onReaction() {
			const Reaction = GoatBot.onReaction.get(messageID);
			if (!Reaction) return;
			const command = GoatBot.commands.get(Reaction.commandName);
			if (command) {
				try {
					await command.onReaction({ ...parameters, Reaction, args: [], commandName: Reaction.commandName });
				} catch (err) { log.err("onReaction", Reaction.commandName, err); }
			}
		}

		async function handlerEvent() {
			for (const [key] of GoatBot.eventCommands.entries()) {
				const getEvent = GoatBot.eventCommands.get(key);
				if (getEvent) {
					try {
						await getEvent.onStart({ ...parameters, commandName: getEvent.config.name });
					} catch (err) { log.err("EVENT", getEvent.config.name, err); }
				}
			}
		}

		return { onStart, onChat, onReply, onReaction, handlerEvent, onAnyEvent: async() => {}, onFirstChat: async() => {}, onEvent: async() => {}, presence: async() => {}, read_receipt: async() => {}, typ: async() => {} };
	};
};
