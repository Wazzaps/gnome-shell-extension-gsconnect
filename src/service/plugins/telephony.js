"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Contacts = imports.modules.contacts;
const Sms = imports.modules.sms;
const Sound = imports.modules.sound;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: "org.gnome.Shell.Extensions.GSConnect.Plugin.Telephony",
    incomingCapabilities: ["kdeconnect.telephony"],
    outgoingCapabilities: ["kdeconnect.telephony.request", "kdeconnect.sms.request"],
    actions: {
        // Call Actions
        muteCall: {
            summary: _("Mute Call"),
            description: _("Silence an incoming call"),
            signature: null,
            incoming: ["kdeconnect.telephony"],
            outgoing: ["kdeconnect.telephony.request"],
            allow: 6
        },

        // SMS Actions
        openSms: {
            summary: _("Open SMS"),
            description: _("Start a new SMS conversation"),
            signature: null,
            incoming: ["kdeconnect.telephony"],
            outgoing: ["kdeconnect.sms.request"],
            allow: 6
        },
        replyMissedCall: {
            summary: _("Reply Missed Call"),
            description: _("Reply to a missed call by SMS"),
            signature: "av",
            incoming: ["kdeconnect.telephony"],
            outgoing: ["kdeconnect.sms.request"],
            allow: 6
        },
        replySms: {
            summary: _("Reply SMS"),
            description: _("Reply to an SMS message"),
            signature: "av",
            incoming: ["kdeconnect.telephony"],
            outgoing: ["kdeconnect.sms.request"],
            allow: 6
        },
        sendSms: {
            summary: _("Send SMS"),
            description: _("Send an SMS message"),
            signature: "av",
            incoming: ["kdeconnect.telephony"],
            outgoing: ["kdeconnect.sms.request"],
            allow: 6
        }
    },
    events: {
        // SMS Events
        missedCall: {
            summary: _("Missed Call"),
            description: _("An incoming call was missed"),
            incoming: ["kdeconnect.telephony"],
            allow: 4
        },
        ringing: {
            summary: _("Incoming Call"),
            description: _("An incoming call"),
            incoming: ["kdeconnect.telephony"],
            allow: 4
        },
        sms: {
            summary: _("SMS Message"),
            description: _("An incoming SMS message"),
            incoming: ["kdeconnect.telephony"],
            allow: 4
        },
        talking: {
            summary: _("Call In Progress"),
            description: _("An incoming call was answered"),
            incoming: ["kdeconnect.telephony"],
            allow: 4
        },
        // FIXME: isCancel???
        ended: {
            summary: _("Call Ended"),
            description: _("An incoming call ended"),
            incoming: ["kdeconnect.telephony"],
            allow: 4
        }
    }
};


/**
 * sms/tel URI RegExp (https://tools.ietf.org/html/rfc5724)
 *
 * A fairly lenient regexp for sms: URIs that allows tel: numbers with chars
 * from global-number, local-number (without phone-context) and single spaces,
 * allowing passing numbers directly from libfolks or GData without
 * pre-processing. It also makes an allowance for URIs passed from Gio.File
 * that always come in the form "sms:///".
 */
let _smsParam = "[\\w.!~*'()-]+=(?:[\\w.!~*'()-]|%[0-9A-F]{2})*";
let _telParam = ";[a-zA-Z0-9-]+=(?:[\\w\\[\\]/:&+$.!~*'()-]|%[0-9A-F]{2})+";
let _lenientDigits = "[+]?(?:[0-9A-F*#().-]| (?! )|%20(?!%20))+";
let _lenientNumber = _lenientDigits + "(?:" + _telParam + ")*";

var _smsRegex = new RegExp(
    "^" +
    "sms:" +                                // scheme
    "(?:[/]{2,3})?" +                       // Gio.File returns ":///"
    "(" +                                   // one or more...
        _lenientNumber +                    // phone numbers
        "(?:," + _lenientNumber + ")*" +    // separated by commas
    ")" +
    "(?:\\?(" +                             // followed by optional...
        _smsParam +                         // parameters...
        "(?:&" + _smsParam + ")*" +         // separated by "&" (unescaped)
    "))?" +
    "$", "g");                              // fragments (#foo) not allowed


var _numberRegex = new RegExp(
    "^" +
    "(" + _lenientDigits + ")" +            // phone number digits
    "((?:" + _telParam + ")*)" +            // followed by optional parameters
    "$", "g");


/**
 * Telephony Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/telephony
 *
 * Packets:
 *  {
 *      type: "kdeconnect.telephony"
 *      id: {Number microseconds timestamp}
 *      body: {
 *          event: {String} missedCall | ringing | sms | talking,
 *          [contactName]: {String} Sender's name (optional),
 *          phoneNumber: {String} Sender's phone number (mandatory?),
 *          [messageBody]: {String} SMS message body (mandatory for 'sms' events),
 *          [phoneThumbnail]: {String} base64 encoded JPEG bytes,
 *          [isCancel]: {Boolean} Marks the end of a 'ringing'/'talking' event
 *      }
 *  }
 *
 *
 * TODO: track notifs: isCancel events, append new messages to unacknowledged?
 */
var Plugin = new Lang.Class({
    Name: "GSConnectTelephonyPlugin",
    Extends: PluginsBase.Plugin,

    _init: function (device) {
        this.parent(device, "telephony");

        this.contacts = Contacts.getStore();
    },

    // FIXME: use contact cache
    handlePacket: function (packet) {
        debug(packet);

        let event = this._parsePacket(packet);

        // Event handling
        // The event has ended (ringing stopped or call ended)
        if (event.isCancel) {
            this._setMediaState(1);
            this.device.withdraw_notification(event.event + "|" + event.contact.name); // FIXME
        // An event was triggered
        } else {
            this.emit(
                "event",
                event.event,
                gsconnect.full_pack([
                    event.contact.name || "",
                    event.phoneNumber || "",
                    event.contact.avatar || "",
                    event.messageBody || ""
                ])
            );

            return new Promise((resolve, reject) => {
                if (event.event === "sms" && this.allow & Allow.SMS) {
                    resolve(this._onSms(event));
                } else if (this.allow & Allow.CALLS) {
                    switch (event.event) {
                        case "missedCall":
                            resolve(this._onMissedCall(event));
                            break;
                        case "ringing":
                            resolve(this._onRinging(event));
                            break;
                        case "talking":
                            resolve(this._onTalking(event));
                            break;
                        default:
                            log("Unknown telephony event");
                            reject(false);
                    }
                } else {
                    reject(false);
                }
            });
        }
    },

    /**
     * Parse an telephony packet and return an event object, with ... TODO
     *
     * @param {object} packet - A telephony event packet
     * @return {object} - An event object
     */
    _parsePacket: function (packet) {
        let event = packet.body;
        event.time = GLib.DateTime.new_now_local().to_unix();

        event.contact = this.contacts.getContact(
            event.contactName,
            event.phoneNumber
        );

        // Update contact avatar
        // FIXME: move to modules/contacts.js
        if (event.phoneThumbnail) {
            if (!event.contact.avatar) {
                debug("updating avatar for " + event.contact.name);

                let path = this.contacts._cacheDir + "/" + GLib.uuid_string_random() + ".jpeg";
                GLib.file_set_contents(
                    path,
                    GLib.base64_decode(event.phoneThumbnail)
                );
                event.contact.avatar = path;
                this.contacts._writeCache();
            }

            delete event.phoneThumbnail;
        }

        // Set an icon appropriate for the event
        if (event.contact.avatar) {
            event.gicon = this.contacts.getContactPixbuf(event.contact.avatar);
        } else if (event.event === "missedCall") {
            event.gicon = new Gio.ThemedIcon({ name: "call-missed-symbolic" });
        } else if (["ringing", "talking"].indexOf(event.event) > -1) {
            event.gicon = new Gio.ThemedIcon({ name: "call-start-symbolic" });
        } else if (event.event === "sms") {
            event.gicon = new Gio.ThemedIcon({ name: "sms-symbolic" });
        }

        return event;
    },

    /**
     * Telephony event handlers
     */
    _onMissedCall: function (event) {
        debug(event);

        // Start tracking the duplicate early
        let notification = this.device._plugins.get("notification");

        if (notification) {
            // TRANSLATORS: This is specifically for matching missed call notifications on Android.
            // You should translate this to match the notification on your phone that in english looks like "Missed call: John Lennon"
            notification.markDuplicate({
                localId: "missedCall|" + event.time,
                ticker: _("Missed call") + ": " + event.contact.name,
            });
        }

        // Check for an extant window
        let window = this._hasWindow(event.phoneNumber);

        if (window) {
            // FIXME: log the missed call in the window
            window.receiveMessage(
                event.contact,
                event.phoneNumber,
                "<i>" + _("Missed call at %s").format(event.time) + "</i>"
            );
            window.urgency_hint = true;
            window._notifications.push([
                event.event,
                event.contact.name + ": " + event.messageBody
            ].join("|"));

            // Tell the notification plugin to mark any duplicate read
            if (notification) {
                notification.markDuplicate({
                    localId: "missedCall|" + event.time,
                    ticker: event.contact.name + ": " + event.messageBody,
                    isCancel: true
                });
            }
        }

        let notif = new Gio.Notification();
        // TRANSLATORS: Missed Call
        notif.set_title(_("Missed Call"));
        notif.set_body(
            // TRANSLATORS: eg. Missed call from John Smith on Google Pixel
            _("Missed call from %s on %s").format(
                event.contact.name,
                this.device.name
            )
        );
        notif.set_icon(event.gicon);
        notif.set_priority(Gio.NotificationPriority.NORMAL);

        notif.add_device_button(
            // TRANSLATORS: Reply to a missed call by SMS
            _("Message"),
            this._dbus.get_object_path(),
            "replyMissedCall",
            event.phoneNumber,
            event.contact.name,
            event.time
        );

        this.device.send_notification(event.event + "|"  + event.time, notif);

        return true;
    },

    _onRinging: function (event) {
        debug(event);

        let notif = new Gio.Notification();
        // TRANSLATORS: Incoming Call
        notif.set_title(_("Incoming Call"));
        notif.set_body(
            // TRANSLATORS: eg. Incoming call from John Smith on Google Pixel
            _("Incoming call from %s on %s").format(event.contact.name, this.device.name)
        );
        notif.set_icon(event.gicon);
        notif.set_priority(Gio.NotificationPriority.URGENT);

        notif.add_device_button(
            // TRANSLATORS: Silence an incoming call
            _("Mute"),
            this._dbus.get_object_path(),
            "muteCall"
        );

        this.device.send_notification(event.event + "|"  + event.time, notif);
        this._setMediaState(2);

        return true;
    },

    _onSms: function (event) {
        debug(event);

        // Start tracking the duplicate early
        let notification = this.device._plugins.get("notification");

        if (notification) {
            notification.markDuplicate({
                localId: "sms|" + event.time,
                ticker: event.contact.name + ": " + event.messageBody
            });
        }

        // Check for an extant window
        let window = this._hasWindow(event.phoneNumber);

        if (window) {
            window.receiveMessage(
                event.contact,
                event.phoneNumber,
                event.messageBody
            );
            window.urgency_hint = true;
            window._notifications.push([
                event.event,
                event.contact.name + ": " + event.messageBody
            ].join("|"));

            // Tell the notification plugin to mark any duplicate read
            if (notification) {
                notification.markDuplicate({
                    localId: "sms|" + event.time,
                    ticker: event.contact.name + ": " + event.messageBody,
                    isCancel: true
                });
            }
        }

        let notif = new Gio.Notification();
        notif.set_title(event.contact.name);
        notif.set_body(event.messageBody);
        notif.set_icon(event.gicon);
        notif.set_priority(Gio.NotificationPriority.HIGH);

        notif.set_device_action(
            this._dbus.get_object_path(),
            "replySms",
            event.phoneNumber,
            event.contact.name,
            event.messageBody,
            event.time
        );

        this.device.send_notification(event.event + "|"  + event.time, notif);

        return true;
    },

    _onTalking: function (event) {
        debug(event);

        // TODO: need this, or done by isCancel?
        this.device.withdraw_notification("ringing|" + event.contact.name);

        let notif = new Gio.Notification();
        // TRANSLATORS: Talking on the phone
        notif.set_title(_("Call In Progress"));
        notif.set_body(
            // TRANSLATORS: eg. Call in progress with John Smith on Google Pixel
            _("Call in progress with %s on %s").format(
                event.contact.name,
                this.device.name
            )
        );
        notif.set_icon(event.gicon);
        notif.set_priority(Gio.NotificationPriority.NORMAL);

        this.device.send_notification(event.event + "|"  + event.time, notif);
        this._setMediaState(2);

        return true;
    },

    /**
     * Check if there's an open conversation for a number(s)
     *
     * @param {string|array} phoneNumber - A string phone number or array of
     */
    _hasWindow: function (number) {
        debug(number);

        number = number.replace(/\D/g, "");

        // Get the current open windows
        let windows = this.device.daemon.get_windows();
        let conversation = false;

        // Look for an open window with this contact
        for (let index_ in windows) {
            let win = windows[index_];

            if (!win.device || win.device.id !== this.device.id) {
                continue;
            }

            if (number === win.number.replace(/\D/g, "")) {
                conversation = win;
                break;
            }
        }

        return conversation;
    },

    _setMediaState: function (state) {
        if (state === 1) {
            this._state = 1;
        } else {
            this._state = 2;

            if (state & 2) {
                this._state &= state;
            } else if (state & 4) {
                this._state &= state;
            }
        }
    },

    /**
     * Silence an incoming call
     */
    muteCall: function () {
        debug("");

        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.telephony.request",
            body: { action: "mute" }
        });
        this.sendPacket(packet);
    },

    /**
     * Open and present a new SMS window
     */
    openSms: function () {
        debug(arguments);

        let window = new Sms.ConversationWindow(this.device);
        window.present();
    },


    // FIXME FIXME
    openUri: function (uri) {
        debug(arguments);

        if (!uri instanceof SmsURI) {
            try {
                uri = new SmsURI(uri);
            } catch (e) {
                debug("Error parsing sms URI: " + e.message);
                return;
            }
        }

        // Check for an extant window
        let window = this._hasWindow(uri.recipients);

        // None found; open one and add the contact(s)
        if (!window) {
            window = new Sms.ConversationWindow(this.device);

            for (let recipient of uri.recipients) {
                // FIXME
                let contact = this.contacts.query({
                    number: recipient,
                    name: "",
                    single: false
                });
                window.addRecipient(recipient, contact);
            }
            window.urgency_hint = true;
        }

        // Set the outgoing message if the uri has a body variable
        if (uri.body) {
            window.setMessage(uri.body);
        }

        window.present();
    },

    /**
     * Either open a new SMS window for the caller or reuse an existing one
     *
     * @param {string} phoneNumber - The sender's phone number
     * @param {string} contactName - The sender's name
     * @param {number} time - The event time in epoch us
     */
    replyMissedCall: function (phoneNumber, contactName, time) {
        debug(event);

        // Get a contact
        let contact = this.contacts.getContact(
            phoneNumber,
            contactName
        );

        // Check open windows for this number
        let window = this._hasWindow(phoneNumber);

        // None found; open one, mark duplicate read
        if (!window) {
            window = new Sms.ConversationWindow(this.device);

            // Tell the notification plugin to mark any duplicate read
            if (this.device._plugins.has("notification")) {
                this.device._plugins.get("notification").markDuplicate({
                    localId: "missedCall|" + time,
                    ticker: _("Missed call") + ": " + contact.name,
                    isCancel: true
                });
            }
        }

        // FIXME: log the missed call in the window
        window.receiveMessage(
            contact,
            phoneNumber,
            "<i>" + _("Missed call at %s").format(time) + "</i>"
        );

        window.present();
    },

    /**
     * Either open a new SMS window for the sender or reuse an existing one
     *
     * @param {string} phoneNumber - The sender's phone number
     * @param {string} contactName - The sender's name
     * @param {string} messageBody - The SMS message
     * @param {number} time - The event time in epoch us
     */
    replySms: function (phoneNumber, contactName, messageBody, time) {
        debug(arguments);

        // Check for an extant window
        let window = this._hasWindow(phoneNumber);

        // None found
        if (!window) {
            // Open a new window
            window = new Sms.ConversationWindow(this.device);

            let contact = this.contacts.getContact(
                contactName,
                phoneNumber
            );

            // Log the message
            window.receiveMessage(contact, phoneNumber, messageBody);
            window.urgency_hint = true;

            // Tell the notification plugin to mark any duplicate read
            let notification = this.device._plugins.get("notification");
            if (notification) {
                notification.markDuplicate({
                    localId: "sms|" + time,
                    ticker: contact.name + ": " + messageBody,
                    isCancel: true
                });
            }
        }

        window.present();
    },

    /**
     * Send an SMS message
     *
     * @param {string} phoneNumber - The phone number to send the message to
     * @param {string} messageBody - The message to send
     */
    sendSms: function (phoneNumber, messageBody) {
        debug("Telephony: sendSms(" + phoneNumber + ", " + messageBody + ")");

        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.sms.request",
            body: {
                sendSms: true,
                phoneNumber: phoneNumber,
                messageBody: messageBody
            }
        });

        this.sendPacket(packet);
    },

    /**
     * Share a link by SMS message
     *
     * @param {string} url - The link to be shared
     */
    // FIXME: re-check
    shareUri: function (url) {
        // Get the current open windows
        let windows = this.device.daemon.get_windows();
        let hasConversations = false;

        for (let index_ in windows) {
            let window = windows[index_];

            if (window.device && window.device.id === this.device.id) {
                if (window.number) {
                    hasConversations = true;
                    break;
                }
            }
        }

        let window;

        if (hasConversations) {
            window = new Sms.ShareWindow(this.device, url);
        } else {
            window = new Sms.ConversationWindow(this.device);
            window.setMessage(url);
        }

        window.present();
    }
});


/**
 * A simple parsing class for sms: URI's (https://tools.ietf.org/html/rfc5724)
 */
var SmsURI = new Lang.Class({
    Name: "GSConnectSmsURI",

    _init: function (uri) {
        debug("SmsURI: _init(" + uri + ")");

        let full, recipients, query;

        try {
            _smsRegex.lastIndex = 0;
            [full, recipients, query] = _smsRegex.exec(uri);
        } catch (e) {
            throw URIError("malformed sms URI");
        }

        this.recipients = recipients.split(",").map((recipient) => {
            _numberRegex.lastIndex = 0;
            let [full, number, params] = _numberRegex.exec(recipient);

            if (params) {
                for (let param of params.substr(1).split(";")) {
                    let [key, value] = param.split("=");

                    // add phone-context to beginning of
                    if (key === "phone-context" && value.startsWith("+")) {
                        return value + unescape(number);
                    }
                }
            }

            return unescape(number);
        });

        if (query) {
            for (let field of query.split("&")) {
                let [key, value] = field.split("=");

                if (key === "body") {
                    if (this.body) {
                        throw URIError('duplicate "body" field');
                    }

                    this.body = (value) ? decodeURIComponent(value) : undefined;
                }
            }
        }
    },

    toString: function () {
        let uri = "sms:" + this.recipients.join(",");

        return (this.body) ? uri + "?body=" + escape(this.body) : uri;
    }
});

