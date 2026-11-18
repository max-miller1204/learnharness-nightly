# Set up macOS signing for LearnHarness Nightly

You need a Mac and an active Apple Developer Program membership. Use the Apple Developer Account Holder account for the certificate and for requesting API access if prompted.

## Create the signing certificate

1. Open **Keychain Access → Certificate Assistant → Request a Certificate from a Certificate Authority**. Enter your email and a name for the key, leave the CA email blank, and choose **Saved to disk**. This creates a `.certSigningRequest` file and puts the matching private key in your keychain. [Apple’s signing request guide](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/)
2. In your Apple Developer account, open **Certificates, Identifiers & Profiles → Certificates → +**. Choose **Developer ID Application**, upload the request, download the certificate and double-click it on the Mac where you created the request. [Apple’s Developer ID guide](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
3. In Keychain Access, open **My Certificates** and expand the certificate to check that its private key appears beneath it. Export the signing identity as a password-protected `.p12` and save the password. You can also use **Xcode → Settings → Accounts → your team → Manage Certificates → Export Certificate**. [Apple’s certificate export guide](https://developer.apple.com/documentation/xcode/sharing-your-teams-signing-certificates)

## Create an App Store Connect Team API key

1. Open **App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys**. Request API access if prompted. [Apple’s Team API key guide](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/)
2. Choose **Generate API Key**, name it for LearnHarness nightly notarization and choose **Developer**. Apple lists this role as able to notarize apps. [Apple’s account roles](https://developer.apple.com/help/account/access/roles/)
3. Download the private `AuthKey_…​.p8` file and save it securely. Apple lets you download it once. Copy the **Key ID** from that key’s row and the **Issuer ID** from the Team Keys page. [Apple’s key and issuer ID guide](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests)

## Enter the five GitHub repository secrets

In the LearnHarness fork, open **Settings → Secrets and variables → Actions → New repository secret** and add one secret for each row. On your Mac, `base64 -i "/path/to/DeveloperID.p12" | pbcopy` copies the encoded signing identity to your clipboard for the first row. [GitHub’s repository secret guide](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets#creating-secrets-for-a-repository)

| Secret name | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64 of the exported `.p12` |
| `MAC_CSC_KEY_PASSWORD` | The password you chose when exporting the `.p12` |
| `APPLE_API_KEY` | The complete raw text of the `.p8` file, including its opening and closing lines |
| `APPLE_API_KEY_ID` | The Key ID for that Team API key |
| `APPLE_API_ISSUER` | The Issuer ID shown on the Team Keys page |

Once set up, a publishing nightly on `main` can sign the app, wait for Apple to accept it and validate the stapled ticket. A failed signing, notarization or verification step blocks the whole release, including the server archives. Artifact-only dry runs use unsigned macOS packages. [Nightly specification](specs/electron-nightlies.md)
