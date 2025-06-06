const {Firestore} = require('@google-cloud/firestore');
const simpleParser = require('mailparser').simpleParser;

/**
 * Function to register SMTP hooks for handling email using Firestore.
 */
exports.register = function () {
    this.load_config();

    this.register_hook('init_master', 'initialize_firestore');
    this.register_hook('init_child', 'initialize_firestore');
    this.register_hook('data', 'enable_transaction_body_parse');
    this.register_hook('queue', 'persist_email_details');
};

/**
 * Function to load the plugin configuration.
 */
exports.load_config = function () {
    this.cfg = this.config.get('firestore.ini', {
        booleans: [
            'gcp.isLocalEnv',
        ]
    }, function () {
        this.load_config();
    });
};

/**
 * Function to initialize the Firestore client.
 * @param next function to call the next function registered on hook queue
 * @param server global server object
 */
exports.initialize_firestore = function (next, server) {
    if (!server.notes.firestore) {
        server.notes.firestore = new Firestore({
            projectId: this.cfg.gcp.projectId,
            databaseId: this.cfg.gcp.firestoreDbId,
            ...(this.cfg.gcp.isLocalEnv && {keyFilename: this.cfg.gcp.keyFilePath})
        });
        this.loginfo('Firestore client initialized successfully');
    }

    next();
};

/**
 * Function to enable parsing of the email body.
 * @param next function to call the next function registered on hook queue
 * @param connection connection object containing transaction details
 */
exports.enable_transaction_body_parse = function (next, connection) {
    connection.transaction.parse_body = true;
    next();
};

/**
 * Function to save the email most important details in Firestore.
 * @param next function to call the next function registered on hook queue
 * @param connection connection object containing transaction details
 * @returns promise that indicates the status of the message queuing
 */
exports.persist_email_details = async function (next, connection) {
    if (!(connection && connection.transaction)) {
        return next();
    }

    try {
        const storageReference = connection.transaction.notes.storageReference || null;

        const email = await parseEmail(connection);
        const messageId = storageReference ? storageReference.messageId : generateMessageId(email);
        const messageDetails = constructMessageDetails(email, messageId, storageReference);

        const fetchSellerEmailNotificationsDocumentQuery = server.notes.firestore
            .collection(this.cfg.firestore.merchantsPaymentNotificationsCollection).where('notifications_email', '==', messageDetails.to);
        const selleEmailNotificationsDocumentReference = (await fetchSellerEmailNotificationsDocumentQuery.get()).docs[0].ref;
        await selleEmailNotificationsDocumentReference
            .collection(this.cfg.firestore.merchantNotificationCollection)
            .doc(messageId)
            .set(messageDetails);

        this.loginfo(`Message details for ${messageId} successfully persisted in Firestore`);
        return next(OK);
    } catch (error) {
        this.logerror(`Failed to persist email details in Firestore: ${error.message}`);
        return next(DENYSOFT, "Persistence error");
    }
};

/**
 * Function to construct the message details object.
 * @param email parsed email object
 * @param messageId ID of the message
 * @param storageReference optional object containing GCP Storage reference details
 * @returns object containing the message most important details
 */
function constructMessageDetails(email, messageId, storageReference) {
    return {
        messageId: messageId,

        ...(storageReference && {
            bucketName: storageReference.bucketName,
            objectName: storageReference.objectName,
            storageUrl: storageReference.storageUrl
        }),

        subject: email.subject || '',
        from: email.from?.text || '',
        to: email.to?.text || '',
        cc: email.cc?.text || '',
        ccAddresses: (email.cc?.value || []).map(addr => addr.address),
        bcc: email.bcc?.text || '',
        inReplyTo: email.inReplyTo || null,

        date: email.date || new Date().toISOString(),
        receivedDate: new Date().toISOString(),

        attachmentsCount: email.attachments ? email.attachments.length : 0,

        plainTextLength: email.text ? email.text.length : 0,
    };
}

/**
 * Function to parse the raw email stream into a structured format.
 * @param connection connection object containing transaction details
 */
async function parseEmail(connection) {
    return new Promise((resolve, reject) => {
        const options = {
            skipImageLinks: true,
            maxHtmlLengthToParse: 1024 * 1024 * 50
        };

        simpleParser(connection.transaction.message_stream, options)
            .then(resolve)
            .catch(reject);
    });
}

/**
 * Function to generate a unique message ID for the email if it does not exist.
 * @param email parsed email object
 * @returns ID of the message, either from the email object or a generated one
 */
function generateMessageId(email) {
    if (email.messageId) {
        return email.messageId.replace(/[<>]/g, '');
    }

    return crypto.randomBytes(16).toString('hex');
}
