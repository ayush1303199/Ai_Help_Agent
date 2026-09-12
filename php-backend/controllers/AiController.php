<?php

namespace app\controllers;

use Yii;
use yii\web\Controller;
use yii\web\Response;
use yii\web\UploadedFile;

/**
 * AiController — PHP/Yii2 backend API example.
 *
 * This controller demonstrates how a PHP/Yii2 backend can act as
 * an API gateway in front of the Node.js AI service. In a real
 * application you might add authentication, rate limiting, logging,
 * or business logic here before forwarding the request to Node.js.
 *
 * Endpoints:
 *   GET  /ai/health         — proxy to Node.js health check
 *   POST /ai/extract-pdf    — accept PDF upload, forward to Node.js
 *   POST /ai/chat           — non-streaming chat (direct or langchain)
 */
class AiController extends Controller
{
    // Disable CSRF validation for API endpoints (this is an API, not a form)
    public $enableCsrfValidation = false;

    private string $nodeServiceUrl;

    public function init(): void
    {
        parent::init();
        // In a real Yii2 app, load this from a params or env config file.
        $this->nodeServiceUrl = getenv('NODE_AI_SERVICE_URL') ?: 'http://localhost:3001';
    }

    /**
     * GET /ai/health
     * Proxies the Node.js health endpoint.
     */
    public function actionHealth(): Response
    {
        return $this->proxyGet('/api/health');
    }

    /**
     * POST /ai/extract-pdf
     * Accepts a multipart PDF upload and forwards it to the Node.js
     * PDF extraction endpoint.
     */
    public function actionExtractPdf(): Response
    {
        Yii::$app->response->format = Response::FORMAT_JSON;

        $file = UploadedFile::getInstanceByName('file');

        if (!$file) {
            Yii::$app->response->statusCode = 400;
            return $this->asJson(['error' => 'No file uploaded.']);
        }

        if ($file->type !== 'application/pdf') {
            Yii::$app->response->statusCode = 400;
            return $this->asJson(['error' => 'Only PDF files are allowed.']);
        }

        // Save to temp file, then send via cURL/Guzzle to Node.js
        $tempPath = tempnam(sys_get_temp_dir(), 'pdf_');
        $file->saveAs($tempPath);

        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $this->nodeServiceUrl . '/api/extract-pdf',
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => [
                'Content-Type: multipart/form-data',
            ],
            CURLOPT_POSTFIELDS => [
                'file' => new \CURLFile($tempPath, 'application/pdf', $file->name),
            ],
        ]);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        curl_close($ch);

        @unlink($tempPath);

        if ($error) {
            Yii::$app->response->statusCode = 502;
            return $this->asJson(['error' => 'Failed to reach AI service: ' . $error]);
        }

        Yii::$app->response->statusCode = $httpCode;
        return $this->asJson(json_decode($response, true) ?? ['raw' => $response]);
    }

    /**
     * POST /ai/chat
     * Non-streaming chat endpoint — sends messages to the Node.js
     * service and returns the full response. For real-time streaming,
     * the frontend connects to the WebSocket server directly.
     *
     * Expected JSON body:
     *   { "messages": [...], "mode": "direct"|"langchain", "pdfContext": "..." }
     */
    public function actionChat(): Response
    {
        Yii::$app->response->format = Response::FORMAT_JSON;

        $body = json_decode(Yii::$app->request->rawBody, true);

        if (!$body || !isset($body['messages'])) {
            Yii::$app->response->statusCode = 400;
            return $this->asJson(['error' => 'Missing "messages" in request body.']);
        }

        // In a real app you would call the LLM here via the Node.js
        // service or directly. This example shows the structure.
        // For streaming, the frontend should use WebSocket directly.
        return $this->asJson([
            'message' => 'Use the WebSocket server for streaming responses.',
            'ws_url' => getenv('NODE_WS_URL') ?: 'ws://localhost:3002',
            'received_messages' => count($body['messages']),
            'mode' => $body['mode'] ?? 'direct',
        ]);
    }

    /**
     * Helper: proxy a GET request to the Node.js service.
     */
    private function proxyGet(string $path): Response
    {
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $this->nodeServiceUrl . $path,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 10,
        ]);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        Yii::$app->response->statusCode = $httpCode;
        Yii::$app->response->format = Response::FORMAT_JSON;
        return $this->asJson(json_decode($response, true) ?? ['error' => 'Invalid response from AI service']);
    }
}
