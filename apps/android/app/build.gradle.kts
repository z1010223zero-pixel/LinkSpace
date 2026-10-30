plugins {
    id("com.android.application") version "8.7.2"
    id("org.jetbrains.kotlin.android") version "2.0.21"
    // Kotlin 2.0 起 Compose 编译器独立成插件，不再随 kotlin-android 附带
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21"
}

android {
    namespace = "cn.linkspace.client"
    compileSdk = 35

    defaultConfig {
        applicationId = "cn.linkspace.client"
        minSdk = 26          // Android 8.0，覆盖绝大多数在网设备
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    testOptions {
        // 单测跑在 JVM 上，android.util.Log 等框架方法没有真实实现；
        // 让它们返回默认值而不是抛「not mocked」，纯逻辑测试才能落地
        unitTests.isReturnDefaultValues = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
        // BouncyCastle 是 multi-release jar，三个包都带 META-INF/versions/9/... 元数据，
        // 直接合并会报路径重复。这些是 JDK9 模块描述，Android 用不到。
        resources.excludes += "/META-INF/versions/**"
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    // 运行时生成自签证书。Android 没有公开的 Keystore→X.509 自签 API，
    // 系统内置的 BC 是重打包内部类不能依赖，必须显式引入。
    implementation("org.bouncycastle:bcpkix-jdk18on:1.78.1")

    // 协程
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation("junit:junit:4.13.2")
    // InputController 等纯逻辑用 org.json 承载消息，JVM 单测需要同名实现
    testImplementation("org.json:json:20240303")
    androidTestImplementation(composeBom)
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
