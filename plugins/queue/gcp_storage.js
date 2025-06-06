const {Storage} = require('@google-cloud/storage');
const simpleParser = require('mailparser').simpleParser;
const crypto = require('crypto');
const Stream = require('stream');

/**
 * Function to register SMTP hooks for handling email using Google Cloud Storage.
 */
exports.register = function () {
    this.load_config();

    this.register_hook('init_master', 'initialize_storage');
    this.register_hook('init_child', 'initialize_storage');
    this.register_hook('data', 'enable_transaction_body_parse');
    this.register_hook('queue', 'save_email_in_bucket');
};

/**
 * Function to load the plugin configuration.
 */
exports.load_config = function () {
    this.cfg = this.config.get('gcp_storage.ini', {
        booleans: [
            'gcp.isLocalEnv',
            '+queue.isSingleHandler',
        ]
    }, function () {
        this.load_config();
    });
};

/**
 * Function to initialize the Google Cloud Storage client.
 * @param next function to call the next function registered on hook queue
 * @param server global server object
 */
exports.initialize_storage = function (next, server) {
    if (!server.notes.gcpStorage) {
        server.notes.gcpStorage = new Storage({
            projectId: this.cfg.gcp.projectId,
            ...(this.cfg.gcp.isLocalEnv && {keyFilename: this.cfg.gcp.keyFilePath})
        });
        this.loginfo('GCP Storage client initialized successfully');
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
 * Function to save the entire email in a Google Cloud Storage bucket.
 * @param next function to call the next function registered on hook queue
 * @param connection connection object containing transaction details
 * @returns promise that indicates the status of the message queuing
 */
exports.save_email_in_bucket = async function (next, connection) {
    if (!(connection && connection.transaction && connection.transaction.message_stream)) {
        return next();
    }

    try {
        const rawEmailBuffer = await new Promise((resolve, reject) => {
            const chunks = [];
            const messageStream = connection.transaction.message_stream;

            const captureStream = new Stream.PassThrough();
            messageStream.pipe(captureStream);

            captureStream.on('data', chunk => chunks.push(chunk));
            captureStream.on('end', () => resolve(Buffer.concat(chunks)));
            captureStream.on('error', reject);
        });

        const email = await parseEmail(rawEmailBuffer)
        const messageId = generateMessageId(email);

        const bucketName = this.cfg.storage.bucketName;
        const objectName = `emails/${messageId}.eml`;

        await uploadEmailToStorage(rawEmailBuffer, constructObjectMetadata(email, messageId), bucketName, objectName);
        connection.transaction.notes.storageReference = {
            bucketName: bucketName,
            objectName: objectName,
            messageId: messageId,
            storageUrl: `gs://${bucketName}/${objectName}`
        };

        this.loginfo(`Email ${messageId} successfully saved in GCP bucket: ${bucketName}, object: ${objectName}`);
        if (this.cfg.queue.isSingleHandler) {
            connection.loginfo('Single handler mode enabled, message is queued successfully.');
            return next(OK);
        } else {
            connection.loginfo('Proceeding to next handler after saving email in GCP Storage.');
            return next();
        }
    } catch (error) {
        this.logerror(`Failed to save email in GCP Storage: ${error.message}`);
        return next(DENYSOFT, "Persistence error");
    }
};

/**
 * Function to write the email stream to Google Cloud Storage.
 * @param emailBuffer stream representing email
 * @param objectMetadata metadata containing important message details
 * @param bucketName name of the GCP bucket to store the email
 * @param objectName name of the object in the GCP bucket
 */
async function uploadEmailToStorage(emailBuffer, objectMetadata, bucketName, objectName) {
    const bucket = server.notes.gcpStorage.bucket(bucketName);
    const emailObject = bucket.file(objectName);

    await emailObject.save(emailBuffer);
    await emailObject.setMetadata(objectMetadata);
}

/**
 * Function to construct metadata for the email object.
 * @param parsedEmail parsed email object
 * @param messageId ID of the message
 * @returns object containing metadata for the email object
 */
function constructObjectMetadata(parsedEmail, messageId) {
    return {
        contentType: 'message/rfc822',
        resumable: false,
        metadata: {
            messageId: messageId,
            subject: parsedEmail.subject || '',
            from: parsedEmail.from?.text || '',
            to: parsedEmail.to?.text || '',
            date: parsedEmail.date?.toISOString() ?? new Date().toISOString()
        }
    };
}

/**
 * Function to parse the raw email stream into a structured format.
 * @param emailStream stream representing the raw email
 */
async function parseEmail(emailStream) {
    return new Promise((resolve, reject) => {
        const options = {
            skipImageLinks: true,
            maxHtmlLengthToParse: 1024 * 1024 * 50
        };

        simpleParser(emailStream, options)
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

    return `${crypto.randomBytes(16).toString('hex')}-${Date.now()}`;
}
