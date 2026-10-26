package workbench.res;

import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

final class ResServerIntegrationTest {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final HttpClient HTTP = HttpClient.newHttpClient();
  private static HttpServer server;
  private static ExecutorService serverExecutor;
  private static String base;

  @BeforeAll
  static void start() throws Exception {
    server = ResServer.createServer(0);
    serverExecutor = Executors.newFixedThreadPool(4);
    server.setExecutor(serverExecutor);
    server.start();
    base = "http://127.0.0.1:" + server.getAddress().getPort();
  }

  @AfterAll
  static void stop() {
    server.stop(0);
    serverExecutor.shutdownNow();
  }

  private static JsonNode call(String path, String method, JsonNode body, int expectedStatus) throws Exception {
    HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + path));
    if (body == null) request.method(method, HttpRequest.BodyPublishers.noBody());
    else request.method(method, HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body))).header("content-type", "application/json");
    HttpResponse<String> response = HTTP.send(request.build(), HttpResponse.BodyHandlers.ofString());
    assertEquals(expectedStatus, response.statusCode(), response.body());
    return JSON.readTree(response.body());
  }

  private static int status(String baseUrl, String path, String method, JsonNode body, String bearerToken) throws Exception {
    HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(baseUrl + path));
    if (body == null) request.method(method, HttpRequest.BodyPublishers.noBody());
    else request.method(method, HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body))).header("content-type", "application/json");
    if (bearerToken != null) request.header("authorization", "Bearer " + bearerToken);
    return HTTP.send(request.build(), HttpResponse.BodyHandlers.discarding()).statusCode();
  }

  private static JsonNode uncheckedCall(String path, String method, JsonNode body, int expectedStatus) {
    try { return call(path, method, body, expectedStatus); }
    catch (Exception exception) { throw new RuntimeException(exception); }
  }

  private static ObjectNode release(String id, ObjectNode model, String drl) throws Exception {
    ObjectNode release = JSON.createObjectNode();
    release.put("schemaVersion", 1);
    release.put("id", id);
    release.put("decisionService", "test.rule-group");
    release.put("version", 1);
    release.put("name", "Rule Group contract");
    release.put("description", "integration");
    release.putObject("target").put("type", "flow").put("id", "flow-1").put("assetVersion", 1);
    release.putObject("engine").put("type", "drools").put("drools", "10.2.0");
    release.set("model", model);
    ObjectNode step = release.putArray("steps").addObject();
    step.put("name", "规则组：control");
    step.put("type", "rule-group");
    step.put("assetVersion", 1);
    step.put("drl", drl);
    step.putArray("members").addObject().put("type", "rule").put("id", "rule-1").put("version", 1);
    step.put("memberFingerprint", "test-fingerprint");
    release.put("checksum", ResServer.checksum(release));
    return release;
  }

  private static ObjectNode releaseVersion(String id, int version, ObjectNode model, String drl) throws Exception {
    ObjectNode release = release(id, model, drl);
    release.put("version", version);
    release.put("checksum", ResServer.checksum(release));
    return release;
  }

  private static ObjectNode releaseWithSteps(String id, ObjectNode model, String... drls) throws Exception {
    ObjectNode release = release(id, model, drls[0]);
    ArrayNode steps = (ArrayNode) release.withArray("steps");
    steps.removeAll();
    for (int index = 0; index < drls.length; index++) {
      steps.addObject()
          .put("name", "步骤 " + (index + 1))
          .put("type", "rule")
          .put("assetVersion", 1)
          .put("drl", drls[index]);
    }
    release.put("checksum", ResServer.checksum(release));
    return release;
  }

  private static ObjectNode model(String... definitions) {
    ObjectNode model = JSON.createObjectNode();
    model.put("version", 1);
    ArrayNode fields = model.putArray("fields");
    for (String definition : definitions) {
      String[] parts = definition.split(":");
      fields.addObject().put("key", parts[0]).put("type", parts[1]).put("kind", parts[2]).put("required", parts.length > 3 && Boolean.parseBoolean(parts[3]));
    }
    return model;
  }

  @Test
  void checksumIncludesDisplayVersion() throws Exception {
    ObjectNode release = release("display-version-checksum", model("outcome:String:output:false"), """
        package workbench
        declare RuleInput
          outcome : String
        end
        """);
    String withoutDisplayVersion = ResServer.checksum(release);
    release.put("displayVersion", "2.1.1");
    assertNotEquals(withoutDisplayVersion, ResServer.checksum(release));
  }

  @Test
  void managementAndExecutionPlanesUseIndependentPortsAndCredentials() throws Exception {
    assertThrows(IllegalArgumentException.class, () -> new ResServer.AuthConfig("same-secret", "same-secret"));
    ResServer.AuthConfig auth = new ResServer.AuthConfig("management-secret", "execution-secret");
    HttpServer management = ResServer.createServer(0, ResServer.Plane.MANAGEMENT, auth);
    HttpServer execution = ResServer.createServer(0, ResServer.Plane.EXECUTION, auth);
    management.start();
    execution.start();
    String managementBase = "http://127.0.0.1:" + management.getAddress().getPort();
    String executionBase = "http://127.0.0.1:" + execution.getAddress().getPort();
    try {
      assertEquals(200, status(managementBase, "/health", "GET", null, null));
      assertEquals(200, status(executionBase, "/health", "GET", null, null));
      assertEquals(401, status(managementBase, "/status", "GET", null, null));
      assertEquals(401, status(managementBase, "/status", "GET", null, "execution-secret"));
      assertEquals(200, status(managementBase, "/status", "GET", null, "management-secret"));
      assertEquals(401, status(executionBase, "/execute", "POST", JSON.createObjectNode(), null));
      assertEquals(401, status(executionBase, "/execute", "POST", JSON.createObjectNode(), "management-secret"));
      assertEquals(400, status(executionBase, "/execute", "POST", JSON.createObjectNode(), "execution-secret"));
      assertEquals(404, status(managementBase, "/execute", "POST", JSON.createObjectNode(), "execution-secret"));
      assertEquals(404, status(executionBase, "/status", "GET", null, "management-secret"));
    } finally {
      management.stop(0);
      execution.stop(0);
    }
  }

  @Test
  void ruleGroupDeploysExecutesAndValidatesMappings() throws Exception {
    String id = "rule-group-it";
    ObjectNode release = release(id, model("age:Integer:input:true", "nextAge:Integer:output:false"), """
        package workbench
        declare RuleInput
          age : java.lang.Integer
          nextAge : java.lang.Integer
        end
        rule "advance"
        when
          $input : RuleInput(age < 18)
        then
          modify($input) { setNextAge(19) }
        end
        """);
    ((ObjectNode) release.path("steps").get(0)).putArray("outputMappings")
        .addObject().put("source", "nextAge").put("target", "age");
    release.put("checksum", ResServer.checksum(release));
    try {
      assertEquals(id, call("/deploy", "POST", release, 201).path("releaseId").asText());
      ObjectNode request = JSON.createObjectNode();
      request.put("releaseId", id).putObject("facts").put("age", 17);
      JsonNode executed = call("/execute", "POST", request, 200);
      assertEquals(19, executed.path("facts").path("age").asInt());
      assertEquals(1, executed.path("count").asInt());
      assertEquals("advance", executed.path("trace").get(0).path("fired").get(0).asText());

      ObjectNode invalid = release.deepCopy();
      invalid.put("id", "rule-group-invalid-mapping");
      ((ObjectNode) invalid.path("steps").get(0).path("outputMappings").get(0)).put("target", "missing");
      invalid.put("checksum", ResServer.checksum(invalid));
      assertTrue(call("/deploy", "POST", invalid, 400).path("error").asText().contains("字段映射"));
    } finally {
      ObjectNode cleanup = JSON.createObjectNode().put("releaseId", id);
      call("/undeploy", "POST", cleanup, 200);
    }
  }

  @Test
  void decisionServiceExecutesActiveReleaseWithoutReleaseId() throws Exception {
    String firstId = "service-route-v1";
    String secondId = "service-route-v2";
    ObjectNode first = releaseVersion(firstId, 1, model("outcome:String:output:false"), """
        package workbench
        declare RuleInput
          outcome : String
        end
        rule "v1" when $i : RuleInput() then modify($i) { setOutcome("v1") } end
        """);
    ObjectNode second = releaseVersion(secondId, 2, model("outcome:String:output:false"), """
        package workbench
        declare RuleInput
          outcome : String
        end
        rule "v2" when $i : RuleInput() then modify($i) { setOutcome("v2") } end
        """);
    first.put("decisionService", "test.service-route");
    first.put("checksum", ResServer.checksum(first));
    second.put("decisionService", "test.service-route");
    second.put("checksum", ResServer.checksum(second));
    try {
      call("/deploy", "POST", first, 201);
      call("/deploy", "POST", second, 201);

      ObjectNode request = JSON.createObjectNode();
      request.putObject("facts");
      JsonNode initiallyActive = call("/services/test.service-route/execute", "POST", request, 200);
      assertEquals(firstId, initiallyActive.path("releaseId").asText());
      assertEquals("v1", initiallyActive.path("facts").path("outcome").asText());

      ObjectNode activate = JSON.createObjectNode();
      activate.put("releaseId", secondId).put("decisionService", "test.service-route");
      call("/activate", "POST", activate, 200);

      ObjectNode serviceRequest = JSON.createObjectNode();
      serviceRequest.put("decisionService", "test.service-route").putObject("facts");
      JsonNode switched = call("/execute", "POST", serviceRequest, 200);
      assertEquals(secondId, switched.path("releaseId").asText());
      assertEquals("v2", switched.path("facts").path("outcome").asText());
    } finally {
      call("/undeploy", "POST", JSON.createObjectNode().put("releaseId", secondId), 200);
      call("/undeploy", "POST", JSON.createObjectNode().put("releaseId", firstId), 200);
    }
  }

  @Test
  void prepareGenerationCasAndDrainKeepOldGenerationServingUntilRequestCompletes() throws Exception {
    String firstId = "generation-v1";
    String secondId = "generation-v2";
    String service = "test.generation-cas";
    ObjectNode first = releaseVersion(firstId, 1, model("outcome:String:output:false"), """
        package workbench
        declare RuleInput
          outcome : String
        end
        rule "slow v1" when $i : RuleInput() then
          java.util.concurrent.locks.LockSupport.parkNanos(2000000000L);
          modify($i) { setOutcome("v1") }
        end
        """);
    ObjectNode second = releaseVersion(secondId, 2, model("outcome:String:output:false"), """
        package workbench
        declare RuleInput
          outcome : String
        end
        rule "v2" when $i : RuleInput() then modify($i) { setOutcome("v2") } end
        """);
    first.put("decisionService", service).put("checksum", ResServer.checksum(first));
    second.put("decisionService", service).put("checksum", ResServer.checksum(second));
    try {
      assertEquals("ready", call("/prepare", "POST", first, 201).path("state").asText());
      assertEquals("ready", call("/prepare", "POST", second, 201).path("state").asText());
      assertTrue(call("/services/" + service + "/execute", "POST", JSON.createObjectNode().putObject("facts"), 404)
          .path("error").asText().contains("没有当前生效"));

      ObjectNode activateFirst = JSON.createObjectNode()
          .put("releaseId", firstId).put("decisionService", service)
          .put("expectedGeneration", 0).put("generation", 1);
      assertEquals(1, call("/activate", "POST", activateFirst, 200).path("generation").asLong());

      ObjectNode facts = JSON.createObjectNode();
      facts.putObject("facts");
      CompletableFuture<JsonNode> executing = CompletableFuture.supplyAsync(
          () -> uncheckedCall("/services/" + service + "/execute", "POST", facts, 200));
      JsonNode status = null;
      boolean observedInFlight = false;
      for (int attempt = 0; attempt < 50; attempt++) {
        status = call("/status", "GET", null, 200);
        JsonNode deployed = status.path("deployments").findValuesAsText("releaseId").contains(firstId)
            ? status.path("deployments") : JSON.createArrayNode();
        boolean running = false;
        for (JsonNode item : deployed) if (firstId.equals(item.path("releaseId").asText()) && item.path("inFlight").asInt() == 1) running = true;
        if (running) { observedInFlight = true; break; }
        Thread.sleep(10);
      }
      assertTrue(observedInFlight, status == null ? "missing status" : status.toPrettyString());

      ObjectNode stale = JSON.createObjectNode()
          .put("releaseId", secondId).put("decisionService", service)
          .put("expectedGeneration", 0).put("generation", 1);
      JsonNode conflict = call("/activate", "POST", stale, 409);
      assertEquals(1, conflict.path("actualGeneration").asLong());

      ObjectNode activateSecond = JSON.createObjectNode()
          .put("releaseId", secondId).put("decisionService", service)
          .put("expectedGeneration", 1).put("generation", 2);
      JsonNode activated = call("/activate", "POST", activateSecond, 200);
      assertEquals(2, activated.path("generation").asLong());
      assertTrue(activated.path("previousGenerationDraining").asBoolean());
      assertEquals(firstId, call("/status", "GET", null, 200).path("draining").get(0).path("releaseId").asText());

      JsonNode oldResponse = executing.join();
      assertEquals(firstId, oldResponse.path("releaseId").asText());
      assertEquals(1, oldResponse.path("generation").asLong());
      assertEquals("v1", oldResponse.path("facts").path("outcome").asText());
      assertTrue(call("/status", "GET", null, 200).path("draining").isEmpty());

      JsonNode current = call("/services/" + service + "/execute", "POST", facts, 200);
      assertEquals(secondId, current.path("releaseId").asText());
      assertEquals(2, current.path("generation").asLong());
      assertEquals("v2", current.path("facts").path("outcome").asText());
      assertEquals(2, call("/activate", "POST", activateSecond, 200).path("generation").asLong());
    } finally {
      call("/undeploy", "POST", JSON.createObjectNode().put("releaseId", secondId), 200);
      call("/undeploy", "POST", JSON.createObjectNode().put("releaseId", firstId), 200);
    }
  }

  @Test
  void emptyNodeCanBootstrapDirectlyToTheControlPlaneGeneration() throws Exception {
    String id = "generation-bootstrap-v5";
    String service = "test.generation-bootstrap";
    ObjectNode release = releaseVersion(id, 5, model("outcome:String:output:false"), """
        package workbench
        declare RuleInput
          outcome : String
        end
        rule "bootstrap" when $i : RuleInput() then modify($i) { setOutcome("ready") } end
        """);
    release.put("decisionService", service).put("checksum", ResServer.checksum(release));
    try {
      call("/prepare", "POST", release, 201);
      ObjectNode activation = JSON.createObjectNode()
          .put("releaseId", id).put("decisionService", service)
          .put("expectedGeneration", 0).put("generation", 5).put("bootstrap", true);
      JsonNode activated = call("/activate", "POST", activation, 200);
      assertEquals(5, activated.path("generation").asLong());
      ObjectNode request = JSON.createObjectNode();
      request.putObject("facts");
      JsonNode executed = call("/services/" + service + "/execute", "POST", request, 200);
      assertEquals(5, executed.path("generation").asLong());
    } finally {
      call("/undeploy", "POST", JSON.createObjectNode().put("releaseId", id), 200);
    }
  }

  @Test
  void settleFeedsOutputsBackUntilStableAndKeepsRoundTrace() throws Exception {
    String id = "settle-it";
    ObjectNode release = release(id, model("phase:String:input:true", "nextPhase:String:output:false"), """
        package workbench
        declare RuleInput
          phase : String
          nextPhase : String
        end
        rule "A to B" when $i : RuleInput(phase == "A") then modify($i) { setNextPhase("B") } end
        rule "B to C" when $i : RuleInput(phase == "B") then modify($i) { setNextPhase("C") } end
        """);
    try {
      call("/deploy", "POST", release, 201);
      ObjectNode request = JSON.createObjectNode();
      request.put("releaseId", id).put("settle", true).put("maxRounds", 6).putObject("facts").put("phase", "A");
      request.putArray("feedbackMappings").addObject().put("source", "nextPhase").put("target", "phase");
      JsonNode executed = call("/execute", "POST", request, 200);
      assertEquals("C", executed.path("facts").path("phase").asText());
      assertEquals(3, executed.path("rounds").size());
      assertFalse(executed.path("limitReached").asBoolean());
    } finally {
      call("/undeploy", "POST", JSON.createObjectNode().put("releaseId", id), 200);
    }
  }

  @Test
  void boxedBooleanPreservesNullAndOpenApiDocumentsRuleGroup() throws Exception {
    String id = "nullable-it";
    ObjectNode release = release(id, model("flag:Boolean:input:false", "outcome:String:output:false"), """
        package workbench
        declare RuleInput
          flag : java.lang.Boolean
          outcome : String
        end
        rule "missing" when $i : RuleInput(flag == null) then modify($i) { setOutcome("missing") } end
        """);
    try {
      call("/deploy", "POST", release, 201);
      ObjectNode request = JSON.createObjectNode();
      request.put("releaseId", id).putObject("facts");
      JsonNode executed = call("/execute", "POST", request, 200);
      assertEquals("missing", executed.path("facts").path("outcome").asText(), executed.toPrettyString());
      JsonNode openapi = call("/openapi.json", "GET", null, 200);
      assertTrue(openapi.at("/components/schemas/ReleaseStep/properties/type/enum").toString().contains("rule-group"));
    } finally {
      call("/undeploy", "POST", JSON.createObjectNode().put("releaseId", id), 200);
    }
  }

  @Test
  void rulesetVariablesAreScopedToExecuteAndSharedAcrossSteps() throws Exception {
    String id = "ruleset-variable-it";
    ObjectNode release = releaseWithSteps(id, model("age:Integer:input:true", "nextAge:Integer:output:false"), """
        package workbench
        declare RuleInput
          age : java.lang.Integer
          nextAge : java.lang.Integer
        end
        declare RuleContext
          approved : java.lang.Boolean
        end
        rule "mark" when
          $i : RuleInput(age < 18)
          $c : RuleContext()
        then
          modify($c) { setApproved(true) }
        end
        """, """
        package workbench
        declare RuleInput
          age : java.lang.Integer
          nextAge : java.lang.Integer
        end
        declare RuleContext
          approved : java.lang.Boolean
        end
        rule "emit" when
          $i : RuleInput()
          $c : RuleContext(approved == true)
        then
          modify($i) { setNextAge(19) }
        end
        """);
    release.putArray("variables").addObject()
        .put("name", "approved")
        .put("label", "已批准")
        .put("type", "Boolean")
        .put("defaultValue", false)
        .putNull("enum")
        .put("description", "execution-local");
    release.put("checksum", ResServer.checksum(release));
    try {
      call("/deploy", "POST", release, 201);

      ObjectNode request = JSON.createObjectNode();
      request.put("releaseId", id).putObject("facts").put("age", 17);
      JsonNode executed = call("/execute", "POST", request, 200);
      assertTrue(executed.path("variables").path("approved").asBoolean());
      assertEquals(19, executed.path("facts").path("nextAge").asInt());
      assertFalse(executed.path("facts").has("approved"));
      assertTrue(executed.path("trace").get(0).path("variables").path("approved").asBoolean());
      assertTrue(executed.path("trace").get(1).path("variables").path("approved").asBoolean());

      ObjectNode isolated = JSON.createObjectNode();
      isolated.put("releaseId", id).putObject("facts").put("age", 20);
      JsonNode second = call("/execute", "POST", isolated, 200);
      assertFalse(second.path("variables").path("approved").asBoolean());
      assertFalse(second.path("facts").has("nextAge"));

      ObjectNode injected = JSON.createObjectNode();
      injected.put("releaseId", id).putObject("facts").put("age", 20).put("approved", true);
      assertTrue(call("/execute", "POST", injected, 400).path("error").asText().contains("未知事实字段"));
    } finally {
      call("/undeploy", "POST", JSON.createObjectNode().put("releaseId", id), 200);
    }
  }

  @Test
  void rulesetVariablesSurviveSettleRoundsButResetPerRequest() throws Exception {
    String id = "ruleset-variable-settle-it";
    ObjectNode release = releaseWithSteps(id, model("phase:String:input:true", "nextPhase:String:output:false", "outcome:String:output:false"), """
        package workbench
        declare RuleInput
          phase : String
          nextPhase : String
          outcome : String
        end
        declare RuleContext
          seenA : java.lang.Boolean
        end
        rule "mark A" when
          $i : RuleInput(phase == "A")
          $c : RuleContext()
        then
          modify($c) { setSeenA(true) }
          modify($i) { setNextPhase("B") }
        end
        """, """
        package workbench
        declare RuleInput
          phase : String
          nextPhase : String
          outcome : String
        end
        declare RuleContext
          seenA : java.lang.Boolean
        end
        rule "finish B after A" when
          $i : RuleInput(phase == "B")
          $c : RuleContext(seenA == true)
        then
          modify($i) { setOutcome("done") }
        end
        """);
    release.putArray("variables").addObject()
        .put("name", "seenA")
        .put("label", "已见 A")
        .put("type", "Boolean")
        .put("defaultValue", false)
        .putNull("enum")
        .put("description", "settle-round-local");
    release.put("checksum", ResServer.checksum(release));
    try {
      call("/deploy", "POST", release, 201);

      ObjectNode request = JSON.createObjectNode();
      request.put("releaseId", id).put("settle", true).put("maxRounds", 4).putObject("facts").put("phase", "A");
      request.putArray("feedbackMappings").addObject().put("source", "nextPhase").put("target", "phase");
      JsonNode executed = call("/execute", "POST", request, 200);
      assertEquals("done", executed.path("facts").path("outcome").asText(), executed.toPrettyString());
      assertTrue(executed.path("variables").path("seenA").asBoolean());
      assertTrue(executed.path("rounds").get(0).path("variables").path("seenA").asBoolean());
      assertTrue(executed.path("rounds").get(1).path("variables").path("seenA").asBoolean());

      ObjectNode isolated = JSON.createObjectNode();
      isolated.put("releaseId", id).put("settle", true).put("maxRounds", 4).putObject("facts").put("phase", "B");
      isolated.putArray("feedbackMappings").addObject().put("source", "nextPhase").put("target", "phase");
      JsonNode second = call("/execute", "POST", isolated, 200);
      assertFalse(second.path("variables").path("seenA").asBoolean());
      assertFalse(second.path("facts").has("outcome"));
    } finally {
      call("/undeploy", "POST", JSON.createObjectNode().put("releaseId", id), 200);
    }
  }

  @Test
  void exclusiveChainMergesBranchesBackIntoCommonSteps() throws Exception {
    String id = "exclusive-chain-it";
    String declaration = """
        package workbench
        declare RuleInput
          segment : String
          stage : String
          outcome : String
        end
        """;
    ObjectNode release = releaseWithSteps(id, model(
        "segment:String:input:true", "stage:String:output:false", "outcome:String:output:false"),
        declaration + """
        rule "start" when $i : RuleInput(segment == "A") then modify($i) { setStage("common") } end
        """,
        declaration + """
        rule "after merge" when $i : RuleInput(stage == "branch-one") then modify($i) { setStage("merged") } end
        """,
        declaration + """
        rule "first branch" when $i : RuleInput(stage == "common") then modify($i) { setStage("branch-one") } end
        """,
        declaration + """
        rule "second branch" when $i : RuleInput(stage == "merged") then modify($i) { setOutcome("done") } end
        """);
    ObjectNode routing = release.putObject("routing");
    routing.put("type", "exclusive-chain").put("commonStepCount", 2);
    ArrayNode gateways = routing.putArray("gateways");
    ObjectNode firstGateway = gateways.addObject();
    firstGateway.put("id", "gateway-one").put("name", "准入网关").put("afterStep", 1);
    ObjectNode firstBranch = firstGateway.putArray("branches").addObject();
    firstBranch.put("id", "branch-one").put("name", "A 路径").put("default", false);
    firstBranch.putObject("condition").put("field", "segment").put("operator", "==").put("value", "A");
    firstBranch.putArray("stepIndexes").add(2);
    ObjectNode secondGateway = gateways.addObject();
    secondGateway.put("id", "gateway-two").put("name", "复核网关").put("afterStep", 2);
    ObjectNode secondBranch = secondGateway.putArray("branches").addObject();
    secondBranch.put("id", "branch-two").put("name", "完成路径").put("default", false);
    secondBranch.putObject("condition").put("field", "segment").put("operator", "==").put("value", "A");
    secondBranch.putArray("stepIndexes").add(3);
    release.put("checksum", ResServer.checksum(release));
    try {
      call("/deploy", "POST", release, 201);
      ObjectNode request = JSON.createObjectNode();
      request.put("releaseId", id).putObject("facts").put("segment", "A");
      JsonNode executed = call("/execute", "POST", request, 200);
      assertEquals("done", executed.path("facts").path("outcome").asText(), executed.toPrettyString());
      assertFalse(executed.has("path"));
      assertEquals(2, executed.path("paths").size());
      assertEquals("branch-one", executed.path("paths").get(0).path("branchId").asText());
      assertEquals("branch-two", executed.path("paths").get(1).path("branchId").asText());
      assertEquals(6, executed.path("trace").size());
      assertEquals("common:0", executed.path("trace").get(0).path("nodeId").asText());
      assertEquals("gateway-one", executed.path("trace").get(1).path("nodeId").asText());
      assertEquals("branch:branch-one:0", executed.path("trace").get(2).path("nodeId").asText());
      assertEquals("common:1", executed.path("trace").get(3).path("nodeId").asText());
      assertEquals("gateway-two", executed.path("trace").get(4).path("nodeId").asText());
      assertEquals("branch:branch-two:0", executed.path("trace").get(5).path("nodeId").asText());
    } finally {
      call("/undeploy", "POST", JSON.createObjectNode().put("releaseId", id), 200);
    }
  }

  @Test
  void exclusiveDagExecutesNestedGatewaysAndMergeNode() throws Exception {
    String id = "exclusive-dag-it";
    String declaration = """
        package workbench
        declare RuleInput
          segment : String
          stage : String
          outcome : String
        end
        """;
    ObjectNode release = releaseWithSteps(id, model(
        "segment:String:input:true", "stage:String:output:false", "outcome:String:output:false"),
        declaration + """
        rule "entry" when $i : RuleInput(segment == "A") then modify($i) { setStage("entry") } end
        """,
        declaration + """
        rule "adult path" when $i : RuleInput(stage == "entry") then modify($i) { setStage("adult") } end
        """,
        declaration + """
        rule "nested path" when $i : RuleInput(stage == "adult") then modify($i) { setStage("nested") } end
        """,
        declaration + """
        rule "merge" when $i : RuleInput(stage == "nested") then modify($i) { setOutcome("done") } end
        """);
    ObjectNode routing = release.putObject("routing");
    routing.put("type", "exclusive-dag").put("entry", "entry-step");
    ArrayNode nodes = routing.putArray("nodes");
    nodes.addObject().put("id", "entry-step").put("type", "step").put("stepIndex", 0).put("next", "age-gateway");
    ObjectNode ageGateway = nodes.addObject().put("id", "age-gateway").put("type", "gateway").put("name", "年龄判断");
    ObjectNode adult = ageGateway.putArray("branches").addObject();
    adult.put("id", "adult").put("name", "成年人").put("default", false).put("next", "adult-step");
    adult.putObject("condition").put("field", "segment").put("operator", "==").put("value", "A");
    ageGateway.withArray("branches").addObject().put("id", "minor").put("name", "默认").put("default", true).putNull("condition").put("next", "merge-step");
    nodes.addObject().put("id", "adult-step").put("type", "step").put("stepIndex", 1).put("next", "nested-gateway");
    ObjectNode nestedGateway = nodes.addObject().put("id", "nested-gateway").put("type", "gateway").put("name", "嵌套判断");
    ObjectNode nested = nestedGateway.putArray("branches").addObject();
    nested.put("id", "nested").put("name", "嵌套路径").put("default", false).put("next", "nested-step");
    nested.putObject("condition").put("field", "segment").put("operator", "==").put("value", "A");
    nestedGateway.withArray("branches").addObject().put("id", "nested-default").put("name", "默认").put("default", true).putNull("condition").put("next", "merge-step");
    nodes.addObject().put("id", "nested-step").put("type", "step").put("stepIndex", 2).put("next", "merge-step");
    nodes.addObject().put("id", "merge-step").put("type", "step").put("stepIndex", 3).put("next", "end");
    release.put("checksum", ResServer.checksum(release));
    try {
      call("/deploy", "POST", release, 201);
      ObjectNode request = JSON.createObjectNode();
      request.put("releaseId", id).putObject("facts").put("segment", "A");
      JsonNode executed = call("/execute", "POST", request, 200);
      assertEquals("done", executed.path("facts").path("outcome").asText(), executed.toPrettyString());
      assertEquals(2, executed.path("paths").size());
      assertEquals("adult", executed.path("paths").get(0).path("branchId").asText());
      assertEquals("nested", executed.path("paths").get(1).path("branchId").asText());
      assertEquals("entry-step", executed.path("trace").get(0).path("nodeId").asText());
      assertEquals("age-gateway", executed.path("trace").get(1).path("nodeId").asText());
      assertEquals("adult-step", executed.path("trace").get(2).path("nodeId").asText());
      assertEquals("nested-gateway", executed.path("trace").get(3).path("nodeId").asText());
      assertEquals("nested-step", executed.path("trace").get(4).path("nodeId").asText());
      assertEquals("merge-step", executed.path("trace").get(5).path("nodeId").asText());
    } finally {
      call("/undeploy", "POST", JSON.createObjectNode().put("releaseId", id), 200);
    }
  }

  @Test
  void exclusiveGatewayRoutesOnUpdatedRuleProjectVariable() throws Exception {
    String id = "variable-gateway-it";
    String declaration = """
        package workbench
        declare RuleInput
          segment : String
          outcome : String
        end
        declare RuleContext
          approved : java.lang.Boolean
        end
        """;
    ObjectNode release = releaseWithSteps(id, model("segment:String:input:true", "outcome:String:output:false"),
        declaration + """
        rule "approve" when $i : RuleInput(segment == "A") $ctx : RuleContext() then modify($ctx) { setApproved(true) } end
        """,
        declaration + """
        rule "approved path" when $i : RuleInput() then modify($i) { setOutcome("approved") } end
        """);
    release.putArray("variables").addObject()
        .put("name", "approved").put("label", "已批准").put("type", "Boolean")
        .put("defaultValue", false).putNull("enum").put("description", "");
    ObjectNode routing = release.putObject("routing");
    routing.put("type", "exclusive-chain").put("commonStepCount", 1);
    ObjectNode gateway = routing.putArray("gateways").addObject();
    gateway.put("id", "approval-gateway").put("name", "审批判断").put("afterStep", 1);
    ObjectNode branch = gateway.putArray("branches").addObject();
    branch.put("id", "approved").put("name", "已批准").put("default", false);
    branch.putObject("condition").put("fieldSource", "variable").put("field", "approved").put("operator", "==").put("value", true);
    branch.putArray("stepIndexes").add(1);
    release.put("checksum", ResServer.checksum(release));
    try {
      call("/deploy", "POST", release, 201);
      ObjectNode request = JSON.createObjectNode();
      request.put("releaseId", id).putObject("facts").put("segment", "A");
      JsonNode executed = call("/execute", "POST", request, 200);
      assertEquals("approved", executed.path("facts").path("outcome").asText(), executed.toPrettyString());
      assertTrue(executed.path("variables").path("approved").asBoolean());
      assertEquals("approved", executed.path("path").path("branchId").asText());
      assertTrue(executed.path("trace").get(1).path("variables").path("approved").asBoolean());
    } finally {
      call("/undeploy", "POST", JSON.createObjectNode().put("releaseId", id), 200);
    }
  }

  @Test
  void decisionDagMergesIndependentParallelOutputs() throws Exception {
    String id = "decision-dag-parallel-it";
    String declaration = """
        package workbench
        declare RuleInput
          segment : String
          riskLevel : String
          reviewRequired : Boolean
          outcome : String
        end
        """;
    ObjectNode release = releaseWithSteps(id, model(
        "segment:String:input:true", "riskLevel:String:output:false", "reviewRequired:Boolean:output:false", "outcome:String:output:false"),
        declaration + """
        rule "risk branch" when $i : RuleInput(segment == "A") then modify($i) { setRiskLevel("high") } end
        """,
        declaration + """
        rule "review branch" when $i : RuleInput(segment == "A") then modify($i) { setReviewRequired(true) } end
        """,
        declaration + """
        rule "after join" when $i : RuleInput(riskLevel == "high", reviewRequired == true) then modify($i) { setOutcome("done") } end
        """);
    ObjectNode routing = release.putObject("routing");
    routing.put("type", "decision-dag").put("entry", "parallel");
    ArrayNode nodes = routing.putArray("nodes");
    ObjectNode parallel = nodes.addObject().put("id", "parallel").put("type", "parallel").put("name", "并行检查").put("join", "join");
    parallel.putArray("branches").addObject().put("id", "risk").put("name", "风险检查").put("next", "risk-step");
    parallel.withArray("branches").addObject().put("id", "review").put("name", "复核检查").put("next", "review-step");
    nodes.addObject().put("id", "risk-step").put("type", "step").put("stepIndex", 0).put("next", "join");
    nodes.addObject().put("id", "review-step").put("type", "step").put("stepIndex", 1).put("next", "join");
    nodes.addObject().put("id", "join").put("type", "join").put("name", "结果聚合").put("next", "after-join");
    nodes.addObject().put("id", "after-join").put("type", "step").put("stepIndex", 2).put("next", "end");
    release.put("checksum", ResServer.checksum(release));
    try {
      call("/deploy", "POST", release, 201);
      ObjectNode request = JSON.createObjectNode();
      request.put("releaseId", id).putObject("facts").put("segment", "A");
      JsonNode executed = call("/execute", "POST", request, 200);
      assertEquals("high", executed.path("facts").path("riskLevel").asText(), executed.toPrettyString());
      assertTrue(executed.path("facts").path("reviewRequired").asBoolean(), executed.toPrettyString());
      assertEquals("done", executed.path("facts").path("outcome").asText(), executed.toPrettyString());
      assertEquals(List.of("parallel", "risk-step", "review-step", "join", "after-join"),
          JSON.convertValue(executed.path("trace").findValues("nodeId"), new com.fasterxml.jackson.core.type.TypeReference<List<String>>() {}));
    } finally {
      call("/undeploy", "POST", JSON.createObjectNode().put("releaseId", id), 200);
    }
  }

  @Test
  void decisionDagRejectsConflictingParallelOutputs() throws Exception {
    String id = "decision-dag-conflict-it";
    String declaration = """
        package workbench
        declare RuleInput
          segment : String
          riskLevel : String
        end
        """;
    ObjectNode release = releaseWithSteps(id, model("segment:String:input:true", "riskLevel:String:output:false"),
        declaration + "rule \"high\" when $i : RuleInput(segment == \"A\") then modify($i) { setRiskLevel(\"high\") } end",
        declaration + "rule \"low\" when $i : RuleInput(segment == \"A\") then modify($i) { setRiskLevel(\"low\") } end");
    ObjectNode routing = release.putObject("routing");
    routing.put("type", "decision-dag").put("entry", "parallel");
    ArrayNode nodes = routing.putArray("nodes");
    ObjectNode parallel = nodes.addObject().put("id", "parallel").put("type", "parallel").put("name", "并行检查").put("join", "join");
    parallel.putArray("branches").addObject().put("id", "high").put("name", "高风险").put("next", "high-step");
    parallel.withArray("branches").addObject().put("id", "low").put("name", "低风险").put("next", "low-step");
    nodes.addObject().put("id", "high-step").put("type", "step").put("stepIndex", 0).put("next", "join");
    nodes.addObject().put("id", "low-step").put("type", "step").put("stepIndex", 1).put("next", "join");
    nodes.addObject().put("id", "join").put("type", "join").put("name", "结果聚合").put("next", "end");
    release.put("checksum", ResServer.checksum(release));
    try {
      call("/deploy", "POST", release, 201);
      ObjectNode request = JSON.createObjectNode();
      request.put("releaseId", id).putObject("facts").put("segment", "A");
      JsonNode executed = call("/execute", "POST", request, 409);
      assertTrue(executed.path("error").asText().contains("riskLevel"), executed.toPrettyString());
      assertEquals("join", executed.path("failedStep").path("type").asText());
    } finally {
      call("/undeploy", "POST", JSON.createObjectNode().put("releaseId", id), 200);
    }
  }
}
