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
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

final class ResServerIntegrationTest {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final HttpClient HTTP = HttpClient.newHttpClient();
  private static HttpServer server;
  private static String base;

  @BeforeAll
  static void start() throws Exception {
    server = ResServer.startServer(0, false);
    base = "http://127.0.0.1:" + server.getAddress().getPort();
  }

  @AfterAll
  static void stop() {
    server.stop(0);
  }

  private static JsonNode call(String path, String method, JsonNode body, int expectedStatus) throws Exception {
    HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + path));
    if (body == null) request.method(method, HttpRequest.BodyPublishers.noBody());
    else request.method(method, HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body))).header("content-type", "application/json");
    HttpResponse<String> response = HTTP.send(request.build(), HttpResponse.BodyHandlers.ofString());
    assertEquals(expectedStatus, response.statusCode(), response.body());
    return JSON.readTree(response.body());
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
}
